/// <reference path="../../core/nri/nri_interop.d.ts" />
import { MeshletModel } from "../../core/meshlet_model";
import {
    matrixIdentity, matrixMultiply, matrixPerspectiveFovRH, matrixTranspose, XM_PI,
} from "../../core/directx_math";
import { SimpleCamera } from "../../core/simple_camera";

namespace MeshletRenderNri {
    // meshlet_render, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (meshlet_render.hlsl's, the D3D12MeshShaders MeshletRender
    // sample's) and model loader (core/meshlet_model.cpp), through the NRI calls
    // core/nri/nri_interop.d.ts binds, as meshlets_nri draws. SimpleCamera's keys are Donut's Key
    // values (GLFW's key codes), which Nri_IsKeyPressed takes.

    const WINDOW_TITLE = "NRI Example: D3D12 Mesh Shader";
    const MESH_FILE = "media/meshlet_render/Dragon_LOD0.bin";

    // SceneConstantBuffer: World, WorldView, WorldViewProj (float4x4 each), DrawMeshlets (uint),
    // 256-byte aligned; a queued frame's each.
    const CONSTANTS_SIZE = 256;
    const CONSTANT_FLOATS = 49;
    const DRAW_MESHLETS_INDEX = 48;
    // The mesh shader's vertex records (position, normal) and Meshlet (4 uints).
    const VERTEX_STRIDE = 24;
    const MESHLET_STRIDE = 16;
    // MeshInfo, the sample's root constants: IndexBytes, MeshletOffset.
    const MESH_INFO_SIZE = 8;

    // The sample's clear color, (0, 0.2, 0.4).
    const CLEAR_R = 0.0;
    const CLEAR_G = 0.2;
    const CLEAR_B = 0.4;

    // Test mode: the frames rendered, each 1/60 s.
    const TEST_FRAMES = 3;

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
    // primitives) and their views, its index size and its meshlet subsets (offset, count pairs).
    class GpuMesh {
        buffers: NriBufferHandle[] = [];
        views: NriDescriptorHandle[] = [];
        subsets: int[] = [];

        constructor(public indexSize: int) {
        }
    }

    // -test: checks the last frame, read back, as the Donut example does. The background is the clear
    // color at the corners; the dragon covers the pixel its bounding sphere's center projects to and
    // 5% to 60% of the frame; its pixels show the meshlet colors (diffuse red 0 for odd meshlets and
    // 1 for even ones, so some covered pixels have no red and others do).
    function checkFrame(pixels: int[], width: int, height: int, boundingSphere: f32[], worldViewProj: number[]) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const background = 0 | (51 << 8) | (102 << 16);
        const corners = [0, width - 1, (height - 1) * width, height * width - 1];
        for (const cornerIndex of corners) {
            const p = pixels[cornerIndex] & 0xFFFFFF;
            if (p != background) {
                return `corner pixel ${cornerIndex} is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not the clear color`;
            }
        }

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
        if (coverage < 0.05 || coverage > 0.6) {
            return `the dragon covers ${coverage} of the frame`;
        }
        if (noRed < covered / 10 || red < covered / 10) {
            return `no meshlet colors: ${noRed} pixels without red, ${red} with`;
        }

        // The bounding sphere's center through WorldViewProj, to a pixel.
        const c = boundingSphere;
        const m = worldViewProj;
        const x = c[0] * m[0] + c[1] * m[4] + c[2] * m[8] + m[12];
        const y = c[0] * m[1] + c[1] * m[5] + c[2] * m[9] + m[13];
        const w = c[0] * m[3] + c[1] * m[7] + c[2] * m[11] + m[15];
        const px: int = Math.floor((x / w * 0.5 + 0.5) * width);
        const py: int = Math.floor((0.5 - y / w * 0.5) * height);
        if (px < 0 || px >= width || py < 0 || py >= height || (pixels[py * width + px] & 0xFFFFFF) == background) {
            return `the model's center (${px}, ${py}) isn't covered`;
        }
        return "";
    }

    // Port of DirectX-Graphics-Samples' D3D12MeshShaders MeshletRender (as examples/meshlet_render.ts
    // ports it) to NRI: the Stanford dragon drawn by a mesh shader alone, a group per meshlet of each
    // meshlet subset reading the meshlet's vertices and packed triangles from structured buffers,
    // shaded in a color per meshlet. The sample's root signature is the pipeline layout: its constant
    // buffer and buffers root descriptors, its root constants root constants. Drawn straight into the
    // swap chain texture (the sample's R8G8B8A8_UNORM back buffer) with a D32 depth buffer, where the
    // Donut example draws into a color target it blits.
    class MeshletRender {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private pipelineLayout: NriPipelineLayoutHandle | null = null;
        private pipeline: NriPipelineHandle | null = null;
        private constantBuffer: NriBufferHandle | null = null;
        private constantBufferView: NriDescriptorHandle | null = null;
        private depthTexture: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private meshes: GpuMesh[] = [];
        private width: int = 0;
        private height: int = 0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        private constants: f32[] = [];
        private meshInfo: f32[] = [0.0, 0.0];
        private camera: SimpleCamera = new SimpleCamera();
        // The model's bounding sphere: center, radius.
        boundingSphere: f32[] = [0.0, 0.0, 0.0, 0.0];
        // The last frame's WorldViewProj (row vectors), for the test.
        worldViewProj: number[] = matrixIdentity();

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < CONSTANT_FLOATS; i++) {
                this.constants.push(0.0);
            }
            // DrawMeshlets: true.
            Nri_StoreInt32(Ref(this.constants[DRAW_MESHLETS_INDEX]), 1);
            // The sample's camera: at (0, 75, 150) looking down -z, 150 units a second.
            this.camera.init(0.0, 75.0, 150.0);
            this.camera.setMoveSpeed(150.0);
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
                const failure = checkFrame(this.readBack(), this.width, this.height, this.boundingSphere, this.worldViewProj);
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

            // The sample's root signature: CBV(b0), RootConstants(b1, 2), SRV(t0) .. SRV(t3).
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(layoutDesc, 1, MESH_INFO_SIZE, NriStage.AllGraphics);
            Nri_PipelineLayoutDescAddRootDescriptor(layoutDesc, 0, NriDescriptorType.ConstantBuffer, NriStage.AllGraphics);
            for (let t = 0; t < 4; t++) {
                Nri_PipelineLayoutDescAddRootDescriptor(layoutDesc, t, NriDescriptorType.StructuredBuffer, NriStage.AllGraphics);
            }
            this.pipelineLayout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            const pipelineLayout = this.pipelineLayout;
            if (!pipelineLayout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The sample's pipeline state: the default rasterizer state (back faces culled, clockwise
            // front faces), blend state (opaque) and depth state (less, writes).
            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/meshlet_render/${folder}/meshlet_render`;
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
                console.log("Cannot load the meshlet render shaders");
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
        // 4 bytes: raw views).
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
            model.copyBoundingSphere(-1, Ref(this.boundingSphere[0]));

            let ok = true;
            const meshCount = model.getMeshCount();
            for (let i = 0; i < meshCount; i++) {
                // The mesh shader reads the first vertex buffer as positions and normals.
                if (model.getVertexBufferStride(i, 0) != VERTEX_STRIDE) {
                    console.log(`${MESH_FILE}: vertices of another layout than the mesh shader's`);
                    ok = false;
                    break;
                }
                const mesh = new GpuMesh(model.getIndexSize(i));
                this.meshes.push(mesh);
                this.addBuffer(mesh, Nri_CreateUploadedStructuredBufferFromPointer(device, this.queue, model.getVertexBufferData(i, 0),
                    model.getVertexBufferSize(i, 0), 4));
                this.addBuffer(mesh, Nri_CreateUploadedStructuredBufferFromPointer(device, this.queue,
                    model.getData(i, MeshletModelData.Meshlets), model.getDataSize(i, MeshletModelData.Meshlets), MESHLET_STRIDE));
                // The unique vertex indices, rounded up to whole uints, as the sample's buffer.
                const uniqueSize = model.getDataSize(i, MeshletModelData.UniqueVertexIndices);
                const uniqueInts = Math.floor((uniqueSize + 3) / 4);
                const unique: int[] = [];
                for (let j = 0; j < uniqueInts; j++) {
                    unique.push(0);
                }
                model.copyData(i, MeshletModelData.UniqueVertexIndices, Ref(unique[0]));
                this.addBuffer(mesh, Nri_CreateUploadedStructuredBufferFromInts(device, this.queue, Ref(unique[0]), uniqueInts * 4, 4));
                this.addBuffer(mesh, Nri_CreateUploadedStructuredBufferFromPointer(device, this.queue,
                    model.getData(i, MeshletModelData.PrimitiveIndices), model.getDataSize(i, MeshletModelData.PrimitiveIndices), 4));
                if (mesh.views.length != 4) {
                    console.log(`Cannot upload ${MESH_FILE}`);
                    ok = false;
                    break;
                }

                const subsetCount = model.getDataCount(i, MeshletModelData.MeshletSubsets);
                for (let j = 0; j < subsetCount * 2; j++) {
                    mesh.subsets.push(0);
                }
                model.copyData(i, MeshletModelData.MeshletSubsets, Ref(mesh.subsets[0]));
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

        // Waits for the frame that last used this frame's command allocator (and its constants).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // OnUpdate: the camera (its keys; in test mode 1/60 second a frame, as Donut's test mode),
        // then the constants for its view: an identity world, a 60 degree perspective at the
        // swap chain's aspect ratio (near 1, far 1000), stored transposed.
        update(constantsOffset: int, constantBuffer: NriBufferHandle) {
            for (const key of CAMERA_KEYS) {
                this.camera.onKey(key, Nri_IsKeyPressed(this.sample, key) != 0);
            }
            this.camera.update(Math.fround(this.test ? 1.0 / 60.0 : Nri_GetFrameTime(this.sample)));

            const world = matrixIdentity();
            const view = this.camera.viewMatrix();
            const aspectRatio = Math.fround(this.width / this.height);
            const proj = matrixPerspectiveFovRH(Math.fround(XM_PI / 3.0), aspectRatio, 1.0, 1000.0);
            const worldView = matrixMultiply(world, view);
            const worldViewProj = matrixMultiply(worldView, proj);
            this.worldViewProj = worldViewProj;
            const matrices = [matrixTranspose(world), matrixTranspose(worldView), matrixTranspose(worldViewProj)];
            for (let m = 0; m < 3; m++) {
                const matrix = matrices[m];
                for (let i = 0; i < 16; i++) {
                    this.constants[m * 16 + i] = matrix[i];
                }
            }
            Nri_WriteBuffer(constantBuffer, constantsOffset, Ref(this.constants[0]), CONSTANT_FLOATS * 4);
        }

        // PopulateCommandList's draws: each mesh's meshlet subsets, a group per meshlet (between
        // Nri_CmdBeginRendering and Nri_CmdEndRendering).
        recordDraw(commandBuffer: NriCommandBufferHandle, constantsOffset: int) {
            const pipelineLayout = this.pipelineLayout;
            const pipeline = this.pipeline;
            const constantBufferView = this.constantBufferView;
            if (!pipelineLayout || !pipeline || !constantBufferView) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, pipelineLayout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetRootDescriptor(commandBuffer, 0, constantBufferView, constantsOffset);
            for (const mesh of this.meshes) {
                for (let t = 0; t < 4; t++) {
                    Nri_CmdSetRootDescriptor(commandBuffer, 1 + t, mesh.views[t], 0);
                }
                Nri_StoreInt32(Ref(this.meshInfo[0]), mesh.indexSize);
                for (let s = 0; s < mesh.subsets.length; s += 2) {
                    Nri_StoreInt32(Ref(this.meshInfo[1]), mesh.subsets[s]);
                    Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.meshInfo[0]), MESH_INFO_SIZE);
                    Nri_CmdDrawMeshTasks(commandBuffer, mesh.subsets[s + 1], 1, 1);
                }
            }
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            const constantsOffset = queuedFrameIndex * CONSTANTS_SIZE;
            const constantBuffer = this.constantBuffer;
            const depthAttachment = this.depthAttachment;
            if (!constantBuffer || !depthAttachment) {
                return;
            }
            this.update(constantsOffset, constantBuffer);

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: cleared, the dragon.
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
        const meshletRender = new MeshletRender(Nri_CreateSample());
        return meshletRender.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return MeshletRenderNri.main(argc, argv);
}

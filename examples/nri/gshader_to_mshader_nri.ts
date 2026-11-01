/// <reference path="../../core/nri/nri_interop.d.ts" />
import { inverseGaussJordan, multiply, radians, rotation, samplePerspective, translation, transpose } from "../../core/matrix";

namespace GshaderToMshaderNri {
    // gshader_to_mshader, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (gshader_to_mshader.hlsl's and gshader_to_mshader_mesh.hlsl's)
    // and model (read as Donut's loadGltfModel reads it), through the NRI calls
    // core/nri/nri_interop.d.ts binds, with NRIFramework's ImGui for the sample's overlay. This
    // example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Geometry Shader to Mesh Shader";

    // The sample's model (Vulkan-Samples' asset, copied at build time: see VULKAN_SAMPLES_ASSETS_DIR
    // in CMakeLists.txt): its first mesh's first primitive, the node's scale ignored.
    const MODEL_PATH = "media/gshader_to_mshader/teapot.gltf";

    // Nri_LoadGltfModel's vertices: float3 position, float3 normal, float2 texture coordinates.
    const GLTF_VERTEX_FLOATS = 8;
    // The model's vertex buffer: float3 position, float3 normal (the framework's Vertex, as the
    // sample's input layout reads it).
    const VERTEX_FLOATS = 6;
    const NORMAL_OFFSET = 12;
    // The mesh shader's vertices: float4 position, float4 normal (the framework's AlignedVertex).
    const ALIGNED_VERTEX_FLOATS = 8;

    // The framework's Meshlet: uint vertices[64], indices[126], vertex_count, index_count.
    const MESHLET_MAX_VERTICES = 64;
    const MESHLET_MAX_INDICES = 126;
    const MESHLET_VERTEX_COUNT = MESHLET_MAX_VERTICES + MESHLET_MAX_INDICES;
    const MESHLET_INDEX_COUNT = MESHLET_VERTEX_COUNT + 1;
    const MESHLET_UINTS = MESHLET_INDEX_COUNT + 1;
    // Where its prepare_meshlets ends a meshlet: 64 different vertices, or 96 indices (32 triangles,
    // so 64 line vertices out of the mesh shader).
    const MESHLET_SPLIT_VERTICES = 64;
    const MESHLET_SPLIT_INDICES = 96;

    // struct SceneConstants { float4x4 model, view, projection, normal; }, as f32 offsets; a queued
    // frame's each in a constant buffer view of CONST_VIEW_SIZE bytes (D3D12's 256 multiple).
    const CONST_MODEL = 0;
    const CONST_VIEW = 16;
    const CONST_PROJECTION = 32;
    const CONST_NORMAL = 48;
    const CONST_FLOATS = 64;
    const CONST_VIEW_SIZE = 256;

    // The sample's camera: a "look at" camera 10 units back, 60 degrees vertically, reversed depth
    // from 256 to 0.1 (glm::perspective with near and far swapped).
    const CAMERA_POSITION = [0.0, 0.0, -10.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;
    // ApiVulkanSample's mouse controls: degrees per pixel dragged with the left button, zoom per
    // pixel with the right one, panning per pixel with the middle one.
    const ROTATION_SPEED = 1.0;
    const ZOOM_SPEED = 0.005;
    const PAN_SPEED = 0.01;

    // ApiVulkanSample's clear color.
    const CLEAR_COLOR = 0.002;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // -test: checks the last frame, read back, as the Donut example does. The corners are the dark
    // clear color; the cyan teapot covers about 7% of the frame (4% to 12%), its middle included.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const clear = 0x070707;
        const xs = [0, width - 1, 0, width - 1];
        const ys = [0, 0, height - 1, height - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[ys[k] * width + xs[k]] & 0xFFFFFF;
            if (p != clear) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not 7, 7, 7`;
            }
        }
        const middle = pixels[Math.floor(height / 2) * width + Math.floor(width / 2)] & 0xFFFFFF;
        if (!((middle & 0xFF) < 60 && ((middle >> 8) & 0xFF) > 120 && ((middle >> 16) & 0xFF) > 120)) {
            return "the middle isn't the teapot's cyan";
        }
        let teapot = 0;
        for (let i = 0; i < width * height; i++) {
            if ((pixels[i] & 0xFFFFFF) != clear) {
                teapot++;
            }
        }
        const total = width * height;
        const percent = 100.0 * teapot / total;
        console.log(`Teapot: ${percent}% (${teapot} of ${total} pixels)`);
        if (percent < 4.0 || percent > 12.0) {
            return `Teapot: ${percent}% of the pixels, not 4% to 12%`;
        }
        return "";
    }

    // The Vulkan-Samples framework's prepare_meshlets: the index buffer cut into meshlets of whole
    // triangles, each ending at 64 different vertices or 96 indices (a triangle cut short there
    // starts the next meshlet). A meshlet's vertices are the different ones it indexes, in
    // increasing order, the triangle cut short's included. One meshlet record is reused all along:
    // what lies past its counts is the previous meshlets'. Returns the meshlets' uints.
    function prepareMeshlets(indices: int[], indexCount: int, vertexCount: int) {
        const meshlet: int[] = [];
        for (let i = 0; i < MESHLET_UINTS; i++) {
            meshlet.push(0);
        }
        let meshletVertexCount = 0;
        let meshletIndexCount = 0;

        // The meshlet's different vertices (std::set): marked with the meshlet's number.
        const vertexMeshlet: int[] = [];
        for (let v = 0; v < vertexCount; v++) {
            vertexMeshlet.push(-1);
        }
        let vertices: int[] = [];
        // Each meshlet needs to contain full primitives.
        let triangleCheck = 0;

        const meshlets: int[] = [];
        let meshletNumber = 0;
        for (let i = 0; i < indexCount; i++) {
            const index = indices[i];
            meshlet[MESHLET_MAX_VERTICES + meshletIndexCount] = index;
            if (vertexMeshlet[index] != meshletNumber) {
                vertexMeshlet[index] = meshletNumber;
                vertices.push(index);
                meshletVertexCount++;
            }
            meshletIndexCount++;
            triangleCheck = triangleCheck < 3 ? triangleCheck + 1 : 1;

            if (meshletVertexCount == MESHLET_SPLIT_VERTICES || meshletIndexCount == MESHLET_SPLIT_INDICES || i == indexCount - 1) {
                // The set's order.
                for (let a = 1; a < vertices.length; a++) {
                    const value = vertices[a];
                    let b = a;
                    while (b > 0 && vertices[b - 1] > value) {
                        vertices[b] = vertices[b - 1];
                        b--;
                    }
                    vertices[b] = value;
                }
                for (let v = 0; v < vertices.length; v++) {
                    meshlet[v] = vertices[v];
                }
                if (triangleCheck != 3) {
                    meshletIndexCount -= triangleCheck;
                    i -= triangleCheck;
                    triangleCheck = 0;
                }

                meshlet[MESHLET_VERTEX_COUNT] = meshletVertexCount;
                meshlet[MESHLET_INDEX_COUNT] = meshletIndexCount;
                for (let k = 0; k < MESHLET_UINTS; k++) {
                    meshlets.push(meshlet[k]);
                }
                meshletVertexCount = 0;
                meshletIndexCount = 0;
                vertices = [];
                meshletNumber++;
            }
        }
        return meshlets;
    }

    // What a frame in flight records into, its constants' view and its descriptor sets: the model's
    // and the geometry shader's (the constants), the mesh shader's (the constants, meshlets and
    // vertices; null without mesh shaders).
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public constantBufferView: NriDescriptorHandle, public modelSet: NriDescriptorSetHandle,
            public meshSet: NriDescriptorSetHandle | null) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // Port of Vulkan-Samples' gshader_to_mshader (as examples/gshader_to_mshader.ts ports it) to
    // NRI: a lit teapot, and its normals as lines, one per triangle, drawn either by a geometry
    // shader (a line strip out of each triangle the model's draw feeds it) or by a mesh shader (a
    // group per meshlet of the index buffer, reading the vertices and the meshlets from structured
    // buffers).
    class GshaderToMshader {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private depthTexture: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private modelLayout: NriPipelineLayoutHandle | null = null;
        private meshLayout: NriPipelineLayoutHandle | null = null;
        private modelPipeline: NriPipelineHandle | null = null;
        private geometryPipeline: NriPipelineHandle | null = null;
        private meshPipeline: NriPipelineHandle | null = null;
        private constantBuffer: NriBufferHandle | null = null;
        private vertexBuffer: NriBufferHandle | null = null;
        private indexBuffer: NriBufferHandle | null = null;
        private meshletBuffer: NriBufferHandle | null = null;
        private alignedVertexBuffer: NriBufferHandle | null = null;
        private meshletView: NriDescriptorHandle | null = null;
        private alignedVertexView: NriDescriptorHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private indexCount: int = 0;
        private meshletCount: int = 0;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;

        // The sample's settings: which shader draws the normals (one at most): -gshader, -mshader;
        // -noUI: no overlay.
        showNormalsGeo: boolean = false;
        showNormalsMesh: boolean = false;
        noUI: boolean = false;
        // The device has mesh shaders (not D3D11, nor GPUs without them).
        meshShadersSupported: boolean = false;

        // The sample's camera: rotation (degrees about x, y, z) and position.
        private cameraRotation: number[] = [0.0, 0.0, 0.0];
        private cameraPosition: number[] = [CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]];
        // The mouse: buttons held, last position.
        private buttons: boolean[] = [false, false, false];
        private mouseX: number = 0.0;
        private mouseY: number = 0.0;

        // The UBO contents.
        private constants: f32[] = [];

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

            // The depth buffer: D32, reversed (cleared to 0).
            const depthTexture = Nri_CreateDepthTexture(device, this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
                console.log("Cannot create the depth buffer");
                return 0;
            }
            this.depthAttachment = Nri_CreateDepthAttachmentView(depthTexture, NriFormat.D32_SFLOAT);

            this.meshShadersSupported = Nri_IsFeatureSupported(device, NriFeature.MeshShader) != 0;
            if (!this.meshShadersSupported) {
                console.log("The device has no mesh shaders: the normals are drawn by the geometry shader only");
                this.showNormalsMesh = false;
            }

            if (!this.loadModel(device)) {
                return 0;
            }

            // The sample's descriptor set, split by pipeline: the uniforms for the model's and the
            // geometry shader's; the uniforms, meshlets and vertices for the mesh shader's.
            const modelLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(modelLayoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexGeometry, NriRangeFlags.None);
            const modelLayout = Nri_CreatePipelineLayoutFromDesc(device, modelLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(modelLayoutDesc);
            this.modelLayout = modelLayout;
            if (!modelLayout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }
            if (this.meshShadersSupported) {
                const meshLayoutDesc = Nri_CreatePipelineLayoutDesc();
                Nri_PipelineLayoutDescAddRange(meshLayoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Mesh, NriRangeFlags.None);
                Nri_PipelineLayoutDescAddRange(meshLayoutDesc, 0, 0, 2, NriDescriptorType.StructuredBuffer, NriStage.Mesh, NriRangeFlags.None);
                this.meshLayout = Nri_CreatePipelineLayoutFromDesc(device, meshLayoutDesc);
                Nri_DestroyPipelineLayoutDesc(meshLayoutDesc);
                if (!this.meshLayout) {
                    console.log("Cannot create the pipeline layout");
                    return 0;
                }
            }

            // The pipelines, as compiled for the Donut example.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/gshader_to_mshader/${folder}/gshader_to_mshader`;
            this.modelPipeline = this.createPipeline(device, modelLayout, shaders, "model_vs", "", "model_ps");
            this.geometryPipeline = this.createPipeline(device, modelLayout, shaders, "base_vs", "normals_gs", "base_ps");
            if (!this.modelPipeline || !this.geometryPipeline) {
                console.log("Cannot load the gshader_to_mshader shaders");
                return 0;
            }
            if (!this.createMeshPipeline(device, `${shaders}_mesh`)) {
                console.log("Cannot load the gshader_to_mshader mesh shaders");
                return 0;
            }

            // The constants, a queued frame's each; a queued frame's descriptor sets.
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * CONST_VIEW_SIZE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const setsPerFrame = this.meshShadersSupported ? 2 : 1;
            const descriptorPool = Nri_CreateDescriptorPoolWithBuffers(device, setsPerFrame * queuedFrameNum, 0,
                setsPerFrame * queuedFrameNum, 0, 0, 2 * queuedFrameNum, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!constantBuffer || !descriptorPool) {
                console.log("Cannot create the constant buffer");
                return 0;
            }
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const constantBufferView = Nri_CreateConstantBufferView(constantBuffer, i * CONST_VIEW_SIZE, CONST_VIEW_SIZE);
                const modelSet = Nri_AllocateDescriptorSet(descriptorPool, modelLayout, 0, 0);
                if (!constantBufferView || !modelSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(modelSet, 0, 0, constantBufferView);
                const meshSet = this.createMeshSet(descriptorPool, constantBufferView);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), constantBufferView,
                    modelSet, meshSet));
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

        // The model: the framework's glTF loader's vertices (positions, normals normalized) and
        // indices; with mesh shaders, its meshlets and its vertices aligned to float4s.
        loadModel(device: NriDeviceHandle) {
            const model = Nri_LoadGltfModel(MODEL_PATH);
            if (!model) {
                console.log("Cannot load the model: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }
            const vertexCount = Nri_GetGltfModelVertexCount(model, 0);
            this.indexCount = Nri_GetGltfModelIndexCount(model, 0);
            const gltfVertices: f32[] = [];
            for (let i = 0; i < vertexCount * GLTF_VERTEX_FLOATS; i++) {
                gltfVertices.push(0.0);
            }
            const indices: int[] = [];
            for (let i = 0; i < this.indexCount; i++) {
                indices.push(0);
            }
            Nri_CopyGltfModelVertices(model, 0, Ref(gltfVertices[0]));
            Nri_CopyGltfModelIndices(model, 0, Ref(indices[0]));
            Nri_DestroyGltfModel(model);

            const vertices: f32[] = [];
            const alignedVertices: f32[] = [];
            for (let v = 0; v < vertexCount; v++) {
                const g = v * GLTF_VERTEX_FLOATS;
                const nx = gltfVertices[g + 3];
                const ny = gltfVertices[g + 4];
                const nz = gltfVertices[g + 5];
                const inverseLength = 1.0 / Math.sqrt(nx * nx + ny * ny + nz * nz);
                vertices.push(gltfVertices[g + 0]);
                vertices.push(gltfVertices[g + 1]);
                vertices.push(gltfVertices[g + 2]);
                vertices.push(nx * inverseLength);
                vertices.push(ny * inverseLength);
                vertices.push(nz * inverseLength);
                alignedVertices.push(gltfVertices[g + 0]);
                alignedVertices.push(gltfVertices[g + 1]);
                alignedVertices.push(gltfVertices[g + 2]);
                alignedVertices.push(1.0);
                alignedVertices.push(nx * inverseLength);
                alignedVertices.push(ny * inverseLength);
                alignedVertices.push(nz * inverseLength);
                alignedVertices.push(0.0);
            }
            this.vertexBuffer = Nri_CreateUploadedBuffer(device, this.queue, Ref(vertices[0]), vertexCount * VERTEX_FLOATS * 4,
                NriBufferUsage.VertexBuffer);
            this.indexBuffer = Nri_CreateUploadedBufferFromInts(device, this.queue, Ref(indices[0]), this.indexCount * 4,
                NriBufferUsage.IndexBuffer);
            if (!this.vertexBuffer || !this.indexBuffer) {
                console.log("Cannot create the model's buffers");
                return false;
            }
            if (!this.meshShadersSupported) {
                return true;
            }

            const meshlets = prepareMeshlets(indices, this.indexCount, vertexCount);
            this.meshletCount = meshlets.length / MESHLET_UINTS;
            const meshletBuffer = Nri_CreateUploadedStructuredBufferFromInts(device, this.queue, Ref(meshlets[0]), meshlets.length * 4,
                MESHLET_UINTS * 4);
            const alignedVertexBuffer = Nri_CreateUploadedStructuredBuffer(device, this.queue, Ref(alignedVertices[0]),
                alignedVertices.length * 4, ALIGNED_VERTEX_FLOATS * 4);
            this.meshletBuffer = meshletBuffer;
            this.alignedVertexBuffer = alignedVertexBuffer;
            if (!meshletBuffer || !alignedVertexBuffer) {
                console.log("Cannot create the meshlets' buffers");
                return false;
            }
            const meshletView = Nri_CreateStructuredBufferView(meshletBuffer, 0);
            const alignedVertexView = Nri_CreateStructuredBufferView(alignedVertexBuffer, 0);
            this.meshletView = meshletView;
            this.alignedVertexView = alignedVertexView;
            if (!meshletView || !alignedVertexView) {
                console.log("Cannot create the meshlets' views");
                return false;
            }
            return true;
        }

        // A queued frame's mesh shader set: its constants, the meshlets and the aligned vertices; null
        // without mesh shaders.
        createMeshSet(descriptorPool: NriDescriptorPoolHandle, constantBufferView: NriDescriptorHandle): NriDescriptorSetHandle | null {
            const meshLayout = this.meshLayout;
            const meshletView = this.meshletView;
            const alignedVertexView = this.alignedVertexView;
            if (!meshLayout || !meshletView || !alignedVertexView) {
                return null;
            }
            const meshSet = Nri_AllocateDescriptorSet(descriptorPool, meshLayout, 0, 0);
            if (!meshSet) {
                return null;
            }
            Nri_UpdateDescriptor(meshSet, 0, 0, constantBufferView);
            Nri_UpdateDescriptor(meshSet, 1, 0, meshletView);
            Nri_UpdateDescriptor(meshSet, 1, 1, alignedVertexView);
            return meshSet;
        }

        // The model's pipelines (geometry shader "" for none): the model's positions and normals in;
        // reversed depth (greater passes), no culling.
        createPipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, shaders: string, vs: string, gs: string, ps: string) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_${vs}.bin`, vs) != 0;
            if (loaded && gs != "") {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Geometry, `${shaders}_${gs}.bin`, gs) != 0;
            }
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_${ps}.bin`, ps) != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescAddVertexAttribute(desc, "NORMAL", NriFormat.RGB32_SFLOAT, NORMAL_OFFSET);
            Nri_PipelineDescSetCullMode(desc, NriCullMode.None);
            Nri_PipelineDescSetColor(desc, this.viewFormat, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.Greater, 1, 0);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // The normals, by the mesh shader (no task shader: a group per meshlet), lines out; false if
        // it can't be created (true without mesh shaders).
        createMeshPipeline(device: NriDeviceHandle, shaders: string) {
            const meshLayout = this.meshLayout;
            if (!meshLayout) {
                return true;
            }
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Mesh, `${shaders}_normals_ms.bin`, "normals_ms") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_mesh_ps.bin`, "mesh_ps") != 0;
            }
            Nri_PipelineDescSetTopology(desc, NriTopology.LineList);
            Nri_PipelineDescSetCullMode(desc, NriCullMode.None);
            Nri_PipelineDescSetColor(desc, this.viewFormat, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.Greater, 1, 0);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, meshLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            this.meshPipeline = pipeline;
            if (!pipeline) {
                return false;
            }
            return true;
        }

        // Waits for the frame that last used this frame's command allocator (and its constants).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // ApiVulkanSample's mouse handling: dragging with the left button rotates the camera, with
        // the right one zooms, with the middle one pans (the cursor's position as the Donut
        // example's callbacks give it; not while the overlay has the mouse).
        handleMouse() {
            const x = Nri_GetMouseX(this.sample);
            const y = Nri_GetMouseY(this.sample);
            const mouseFree = !this.imgui || Nri_ImguiWantsMouse() == 0;
            for (let button = 0; button < 3; button++) {
                this.buttons[button] = mouseFree && Nri_IsButtonPressed(this.sample, button) != 0;
            }
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

        // The sample's update_uniform_buffers: its camera's matrices, the model turned half a turn
        // about z, and the normal matrix, into this frame's constants.
        writeConstants(queuedFrameIndex: int) {
            const constantBuffer = this.constantBuffer;
            if (!constantBuffer) {
                return;
            }
            const c = this.constants;
            const projection = samplePerspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR);
            // A "look at" camera: translation * rotation (about x, then y, then z).
            const r = this.cameraRotation;
            let rotationMatrix = multiply(rotation(radians(r[0]), 1.0, 0.0, 0.0), rotation(radians(r[1]), 0.0, 1.0, 0.0));
            rotationMatrix = multiply(rotationMatrix, rotation(radians(r[2]), 0.0, 0.0, 1.0));
            const p = this.cameraPosition;
            const view = multiply(translation(p[0], p[1], p[2]), rotationMatrix);
            const model = rotation(Math.PI, 0.0, 0.0, 1.0);
            const normal = transpose(inverseGaussJordan(multiply(view, model)));
            for (let i = 0; i < 16; i++) {
                c[CONST_MODEL + i] = model[i];
                c[CONST_VIEW + i] = view[i];
                c[CONST_PROJECTION + i] = projection[i];
                c[CONST_NORMAL + i] = normal[i];
            }
            Nri_WriteBuffer(constantBuffer, queuedFrameIndex * CONST_VIEW_SIZE, Ref(c[0]), CONST_FLOATS * 4);
        }

        // The sample's overlay (its title, ApiVulkanSample's default): one normals checkbox at a
        // time, checking one unchecks the other.
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPos(10.0, 10.0);
            Nri_ImguiBegin("Vulkan Example", 1);
            if (Nri_ImguiCollapsingHeader("Settings", 1) != 0) {
                const showNormalsGeo = Nri_ImguiCheckbox("Display normals - gshader", this.showNormalsGeo ? 1 : 0) != 0;
                if (showNormalsGeo != this.showNormalsGeo) {
                    this.showNormalsGeo = showNormalsGeo;
                    this.showNormalsMesh = false;
                }
                if (this.meshShadersSupported) {
                    const showNormalsMesh = Nri_ImguiCheckbox("Display normals - mshader", this.showNormalsMesh ? 1 : 0) != 0;
                    if (showNormalsMesh != this.showNormalsMesh) {
                        this.showNormalsMesh = showNormalsMesh;
                        this.showNormalsGeo = false;
                    }
                }
            }
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        // The lit model, and the normals by the geometry or mesh shader (between
        // Nri_CmdBeginRenderingWithDepth and Nri_CmdEndRendering).
        recordDraw(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const descriptorPool = this.descriptorPool;
            const modelLayout = this.modelLayout;
            const modelPipeline = this.modelPipeline;
            const geometryPipeline = this.geometryPipeline;
            const vertexBuffer = this.vertexBuffer;
            const indexBuffer = this.indexBuffer;
            if (!descriptorPool || !modelLayout || !modelPipeline || !geometryPipeline || !vertexBuffer || !indexBuffer) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, modelLayout);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, queuedFrame.modelSet);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, vertexBuffer, 0, VERTEX_FLOATS * 4);
            Nri_CmdSetIndexBuffer(commandBuffer, indexBuffer, 0, NriIndexType.UInt32);
            Nri_CmdSetPipeline(commandBuffer, modelPipeline);
            Nri_CmdDrawIndexed(commandBuffer, this.indexCount, 1, 0, 0, 0);

            if (this.showNormalsGeo) {
                Nri_CmdSetPipeline(commandBuffer, geometryPipeline);
                Nri_CmdDrawIndexed(commandBuffer, this.indexCount, 1, 0, 0, 0);
            }
            if (this.showNormalsMesh) {
                this.recordMeshNormals(commandBuffer, queuedFrame);
            }
        }

        // The normals by the mesh shader: a group per meshlet.
        recordMeshNormals(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const meshLayout = this.meshLayout;
            const meshPipeline = this.meshPipeline;
            const meshSet = queuedFrame.meshSet;
            if (!meshLayout || !meshPipeline || !meshSet) {
                return;
            }
            Nri_CmdSetPipelineLayout(commandBuffer, meshLayout);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, meshSet);
            Nri_CmdSetPipeline(commandBuffer, meshPipeline);
            Nri_CmdDrawMeshTasks(commandBuffer, this.meshletCount, 1, 1);
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.handleMouse();
            this.writeConstants(queuedFrameIndex);

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: cleared (reversed depth: the far plane is 0), the model and its normals,
                // the overlay over them.
                Nri_BeginCommandBuffer(commandBuffer);
                if (this.imgui) {
                    Nri_CmdCopyImguiData(this.sample, commandBuffer);
                }
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    Nri_CmdBeginRenderingWithDepth(commandBuffer, swapChainTexture.colorAttachment, depthAttachment);
                    Nri_CmdClearColor(commandBuffer, CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
                    Nri_CmdClearDepth(commandBuffer, 0.0);
                    this.recordDraw(commandBuffer, queuedFrame);
                    Nri_CmdEndRendering(commandBuffer);
                }
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
                    Nri_DestroyDescriptor(queuedFrame.constantBufferView);
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
                this.destroyDescriptor(this.meshletView);
                this.destroyDescriptor(this.alignedVertexView);
                this.destroyDescriptor(this.depthAttachment);
                const depthTexture = this.depthTexture;
                if (depthTexture) {
                    Nri_DestroyTexture(depthTexture);
                }
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.indexBuffer);
                this.destroyBuffer(this.meshletBuffer);
                this.destroyBuffer(this.alignedVertexBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.modelPipeline);
                this.destroyPipeline(this.geometryPipeline);
                this.destroyPipeline(this.meshPipeline);
                this.destroyLayout(this.modelLayout);
                this.destroyLayout(this.meshLayout);
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
        const gshaderToMshader = new GshaderToMshader(sample);
        // -gshader / -mshader: start with the normals drawn by the geometry / mesh shader; -noUI: no
        // overlay.
        Nri_AddExampleOption(sample, "-gshader");
        Nri_AddExampleOption(sample, "-mshader");
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-gshader") {
                gshaderToMshader.showNormalsGeo = true;
                gshaderToMshader.showNormalsMesh = false;
            } else if (arg == "-mshader") {
                gshaderToMshader.showNormalsMesh = true;
                gshaderToMshader.showNormalsGeo = false;
            } else if (arg == "-noUI") {
                gshaderToMshader.noUI = true;
            }
        }
        return gshaderToMshader.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return GshaderToMshaderNri.main(argc, argv);
}

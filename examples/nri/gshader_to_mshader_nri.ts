/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { inverseGaussJordan, multiply, radians, rotation, samplePerspective, translation, transpose } from "../../core/matrix";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriGltfModel, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

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

    // NriGltfModel.load's vertices: float3 position, float3 normal, float2 texture coordinates.
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

    // A frame in flight's own data: its constants' view and its descriptor sets: the model's
    // and the geometry shader's (the constants), the mesh shader's (the constants, meshlets and
    // vertices; null without mesh shaders).
    class QueuedFrame {
        constructor(public constantBufferView: NriDescriptor, public modelSet: NriDescriptorSet,
            public meshSet: NriDescriptorSet | null) {
        }
    }

    // Port of Vulkan-Samples' gshader_to_mshader (as examples/gshader_to_mshader.ts ports it) to
    // NRI: a lit teapot, and its normals as lines, one per triangle, drawn either by a geometry
    // shader (a line strip out of each triangle the model's draw feeds it) or by a mesh shader (a
    // group per meshlet of the index buffer, reading the vertices and the meshlets from structured
    // buffers).
    class GshaderToMshader {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private depthTexture: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
        private modelLayout: NriPipelineLayout | null = null;
        private meshLayout: NriPipelineLayout | null = null;
        private modelPipeline: NriPipeline | null = null;
        private geometryPipeline: NriPipeline | null = null;
        private meshPipeline: NriPipeline | null = null;
        private constantBuffer: NriBuffer | null = null;
        private vertexBuffer: NriBuffer | null = null;
        private indexBuffer: NriBuffer | null = null;
        private meshletBuffer: NriBuffer | null = null;
        private alignedVertexBuffer: NriBuffer | null = null;
        private meshletView: NriDescriptor | null = null;
        private alignedVertexView: NriDescriptor | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private indexCount: int = 0;
        private meshletCount: int = 0;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views' (the swap chain's).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private swapChainViewFormat: NriFormat = NriFormat.Unknown;

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
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
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
            this.sample.setInitializeCallback(initialize);
            this.sample.setLatencySleepCallback(latencySleep);
            this.sample.setRenderFrameCallback(renderFrame);

            let result = this.sample.run(argc, argv, WINDOW_TITLE, TEST_FRAMES);
            if (result == 0 && this.test) {
                const failure = checkFrame(this.readBack(), this.width, this.height);
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

            // Swap chain: rendered through sRGB views, as the sample's sRGB color buffer (which the
            // Donut example blits into its back buffer).
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.swapChainViewFormat;

            // The depth buffer: D32, reversed (cleared to 0).
            if (!this.createDepth(device)) {
                return 0;
            }

            this.meshShadersSupported = device.isFeatureSupported(NriFeature.MeshShader) != 0;
            if (!this.meshShadersSupported) {
                console.log("The device has no mesh shaders: the normals are drawn by the geometry shader only");
                this.showNormalsMesh = false;
            }

            if (!this.loadModel(device)) {
                return 0;
            }

            // The sample's descriptor set, split by pipeline: the uniforms for the model's and the
            // geometry shader's; the uniforms, meshlets and vertices for the mesh shader's.
            const modelLayoutDesc = NriPipelineLayoutDesc.create();
            modelLayoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexGeometry, NriRangeFlags.None);
            const modelLayout = device.createPipelineLayoutFromDesc(modelLayoutDesc);
            modelLayoutDesc.destroy();
            this.modelLayout = modelLayout;
            if (!modelLayout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }
            if (this.meshShadersSupported) {
                const meshLayoutDesc = NriPipelineLayoutDesc.create();
                meshLayoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Mesh, NriRangeFlags.None);
                meshLayoutDesc.addRange(0, 0, 2, NriDescriptorType.StructuredBuffer, NriStage.Mesh, NriRangeFlags.None);
                this.meshLayout = device.createPipelineLayoutFromDesc(meshLayoutDesc);
                meshLayoutDesc.destroy();
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
            const constantBuffer = device.createHostBuffer(queuedFrameNum * CONST_VIEW_SIZE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const setsPerFrame = this.meshShadersSupported ? 2 : 1;
            const descriptorPool = device.createDescriptorPoolWithBuffers(setsPerFrame * queuedFrameNum, 0,
                setsPerFrame * queuedFrameNum, 0, 0, 2 * queuedFrameNum, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!constantBuffer || !descriptorPool) {
                console.log("Cannot create the constant buffer");
                return 0;
            }
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const constantBufferView = constantBuffer.createConstantView(i * CONST_VIEW_SIZE, CONST_VIEW_SIZE);
                const modelSet = descriptorPool.allocateDescriptorSet(modelLayout, 0, 0);
                if (!constantBufferView || !modelSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                modelSet.updateDescriptor(0, 0, constantBufferView);
                const meshSet = this.createMeshSet(descriptorPool, constantBufferView);
                this.queuedFrames.push(new QueuedFrame(constantBufferView,
                    modelSet, meshSet));
            }

            // The sample's overlay.
            if (!this.noUI) {
                if (this.sample.initImgui(device) == 0) {
                    console.log("Cannot initialize the user interface");
                    return 0;
                }
                this.imgui = true;
            }

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The model: the framework's glTF loader's vertices (positions, normals normalized) and
        // indices; with mesh shaders, its meshlets and its vertices aligned to float4s.
        loadModel(device: NriDevice) {
            const model = NriGltfModel.load(MODEL_PATH);
            if (!model) {
                console.log("Cannot load the model: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }
            const vertexCount = model.getVertexCount(0);
            this.indexCount = model.getIndexCount(0);
            const gltfVertices: f32[] = [];
            for (let i = 0; i < vertexCount * GLTF_VERTEX_FLOATS; i++) {
                gltfVertices.push(0.0);
            }
            const indices: int[] = [];
            for (let i = 0; i < this.indexCount; i++) {
                indices.push(0);
            }
            model.copyVertices(0, Ref(gltfVertices[0]));
            model.copyIndices(0, Ref(indices[0]));
            model.destroy();

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
            this.vertexBuffer = device.createUploadedBuffer(this.queue, Ref(vertices[0]), vertexCount * VERTEX_FLOATS * 4,
                NriBufferUsage.VertexBuffer);
            this.indexBuffer = device.createUploadedBufferFromInts(this.queue, Ref(indices[0]), this.indexCount * 4,
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
            const meshletBuffer = device.createUploadedStructuredBufferFromInts(this.queue, Ref(meshlets[0]), meshlets.length * 4,
                MESHLET_UINTS * 4);
            const alignedVertexBuffer = device.createUploadedStructuredBuffer(this.queue, Ref(alignedVertices[0]),
                alignedVertices.length * 4, ALIGNED_VERTEX_FLOATS * 4);
            this.meshletBuffer = meshletBuffer;
            this.alignedVertexBuffer = alignedVertexBuffer;
            if (!meshletBuffer || !alignedVertexBuffer) {
                console.log("Cannot create the meshlets' buffers");
                return false;
            }
            const meshletView = meshletBuffer.createStructuredView(0);
            const alignedVertexView = alignedVertexBuffer.createStructuredView(0);
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
        createMeshSet(descriptorPool: NriDescriptorPool, constantBufferView: NriDescriptor): NriDescriptorSet | null {
            const meshLayout = this.meshLayout;
            const meshletView = this.meshletView;
            const alignedVertexView = this.alignedVertexView;
            if (!meshLayout || !meshletView || !alignedVertexView) {
                return null;
            }
            const meshSet = descriptorPool.allocateDescriptorSet(meshLayout, 0, 0);
            if (!meshSet) {
                return null;
            }
            meshSet.updateDescriptor(0, 0, constantBufferView);
            meshSet.updateDescriptor(1, 0, meshletView);
            meshSet.updateDescriptor(1, 1, alignedVertexView);
            return meshSet;
        }

        // The model's pipelines (geometry shader "" for none): the model's positions and normals in;
        // reversed depth (greater passes), no culling.
        createPipeline(device: NriDevice, layout: NriPipelineLayout, shaders: string, vs: string, gs: string, ps: string) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_${vs}.bin`, vs) != 0;
            if (loaded && gs != "") {
                loaded = desc.addShader(NriShaderStage.Geometry, `${shaders}_${gs}.bin`, gs) != 0;
            }
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_${ps}.bin`, ps) != 0;
            }
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            desc.addVertexAttribute("NORMAL", NriFormat.RGB32_SFLOAT, NORMAL_OFFSET);
            desc.setCullMode(NriCullMode.None);
            desc.setColor(this.viewFormat, NriColorWrite.RGBA);
            desc.setDepth(NriFormat.D32_SFLOAT, NriCompareOp.Greater, 1, 0);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        // The normals, by the mesh shader (no task shader: a group per meshlet), lines out; false if
        // it can't be created (true without mesh shaders).
        createMeshPipeline(device: NriDevice, shaders: string) {
            const meshLayout = this.meshLayout;
            if (!meshLayout) {
                return true;
            }
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Mesh, `${shaders}_normals_ms.bin`, "normals_ms") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_mesh_ps.bin`, "mesh_ps") != 0;
            }
            desc.setTopology(NriTopology.LineList);
            desc.setCullMode(NriCullMode.None);
            desc.setColor(this.viewFormat, NriColorWrite.RGBA);
            desc.setDepth(NriFormat.D32_SFLOAT, NriCompareOp.Greater, 1, 0);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(meshLayout, desc);
            }
            desc.destroy();
            this.meshPipeline = pipeline;
            if (!pipeline) {
                return false;
            }
            return true;
        }

        // Waits for the frame that last used this frame's command allocator (and its constants).
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // ApiVulkanSample's mouse handling: dragging with the left button rotates the camera, with
        // the right one zooms, with the middle one pans (the cursor's position as the Donut
        // example's callbacks give it; not while the overlay has the mouse).
        handleMouse() {
            const x = this.sample.getMouseX();
            const y = this.sample.getMouseY();
            const mouseFree = !this.imgui || NriImgui.wantsMouse() == 0;
            for (let button = 0; button < 3; button++) {
                this.buttons[button] = mouseFree && this.sample.isButtonPressed(button) != 0;
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
            constantBuffer.write(queuedFrameIndex * CONST_VIEW_SIZE, Ref(c[0]), CONST_FLOATS * 4);
        }

        // The sample's overlay (its title, ApiVulkanSample's default): one normals checkbox at a
        // time, checking one unchecks the other.
        buildUI() {
            this.sample.imguiNewFrame();
            NriImgui.setNextWindowPos(10.0, 10.0);
            NriImgui.begin("Vulkan Example", 1);
            if (NriImgui.collapsingHeader("Settings", 1) != 0) {
                const showNormalsGeo = NriImgui.checkbox("Display normals - gshader", this.showNormalsGeo ? 1 : 0) != 0;
                if (showNormalsGeo != this.showNormalsGeo) {
                    this.showNormalsGeo = showNormalsGeo;
                    this.showNormalsMesh = false;
                }
                if (this.meshShadersSupported) {
                    const showNormalsMesh = NriImgui.checkbox("Display normals - mshader", this.showNormalsMesh ? 1 : 0) != 0;
                    if (showNormalsMesh != this.showNormalsMesh) {
                        this.showNormalsMesh = showNormalsMesh;
                        this.showNormalsGeo = false;
                    }
                }
            }
            NriImgui.end();
            this.sample.imguiRender();
        }

        // The lit model, and the normals by the geometry or mesh shader (between
        // NriCommandBuffer.beginRenderingWithDepth and NriCommandBuffer.endRendering).
        recordDraw(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const descriptorPool = this.descriptorPool;
            const modelLayout = this.modelLayout;
            const modelPipeline = this.modelPipeline;
            const geometryPipeline = this.geometryPipeline;
            const vertexBuffer = this.vertexBuffer;
            const indexBuffer = this.indexBuffer;
            if (!descriptorPool || !modelLayout || !modelPipeline || !geometryPipeline || !vertexBuffer || !indexBuffer) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(modelLayout);
            commandBuffer.setDescriptorSet(0, queuedFrame.modelSet);
            commandBuffer.setVertexBuffer(0, vertexBuffer, 0, VERTEX_FLOATS * 4);
            commandBuffer.setIndexBuffer(indexBuffer, 0, NriIndexType.UInt32);
            commandBuffer.setPipeline(modelPipeline);
            commandBuffer.drawIndexed(this.indexCount, 1, 0, 0, 0);

            if (this.showNormalsGeo) {
                commandBuffer.setPipeline(geometryPipeline);
                commandBuffer.drawIndexed(this.indexCount, 1, 0, 0, 0);
            }
            if (this.showNormalsMesh) {
                this.recordMeshNormals(commandBuffer, queuedFrame);
            }
        }

        // The normals by the mesh shader: a group per meshlet.
        recordMeshNormals(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const meshLayout = this.meshLayout;
            const meshPipeline = this.meshPipeline;
            const meshSet = queuedFrame.meshSet;
            if (!meshLayout || !meshPipeline || !meshSet) {
                return;
            }
            commandBuffer.setPipelineLayout(meshLayout);
            commandBuffer.setDescriptorSet(0, meshSet);
            commandBuffer.setPipeline(meshPipeline);
            commandBuffer.drawMeshTasks(this.meshletCount, 1, 1);
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
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
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.handleMouse();
            this.writeConstants(queuedFrameIndex);

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: cleared (reversed depth: the far plane is 0), the model and its normals,
                // the overlay over them.
                commandBuffer.begin();
                if (this.imgui) {
                    this.sample.copyImguiData(commandBuffer);
                }
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    commandBuffer.beginRenderingWithDepth(this.swapChain.colorAttachment(index), depthAttachment);
                    commandBuffer.clearColor(CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
                    commandBuffer.clearDepth(0.0);
                    this.recordDraw(commandBuffer, queuedFrame);
                    commandBuffer.endRendering();
                }
                if (this.imgui) {
                    commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                    this.sample.drawImgui(commandBuffer, this.viewFormat);
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
                if (this.imgui) {
                    this.sample.imguiEndFrame();
                }
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
                if (this.imgui) {
                    this.sample.destroyImgui();
                }
                for (const queuedFrame of this.queuedFrames) {
                    queuedFrame.constantBufferView.destroy();
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                this.destroyDescriptor(this.meshletView);
                this.destroyDescriptor(this.alignedVertexView);
                this.destroyDescriptor(this.depthAttachment);
                const depthTexture = this.depthTexture;
                if (depthTexture) {
                    depthTexture.destroy();
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
                this.frames.destroy();
                this.swapChain.destroy();
                device.destroy();
            }
            this.sample.destroy();
        }

        destroyDescriptor(descriptor: NriDescriptor | null) {
            if (descriptor) {
                descriptor.destroy();
            }
        }

        destroyBuffer(buffer: NriBuffer | null) {
            if (buffer) {
                buffer.destroy();
            }
        }

        destroyPipeline(pipeline: NriPipeline | null) {
            if (pipeline) {
                pipeline.destroy();
            }
        }

        destroyLayout(layout: NriPipelineLayout | null) {
            if (layout) {
                layout.destroy();
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const gshaderToMshader = new GshaderToMshader(sample);
        // -gshader / -mshader: start with the normals drawn by the geometry / mesh shader; -noUI: no
        // overlay.
        sample.addExampleOption("-gshader");
        sample.addExampleOption("-mshader");
        sample.addExampleOption("-noUI");
        sample.useImgui();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
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

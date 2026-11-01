/// <reference path="../../core/nri/nri_interop.d.ts" />
import { radians, samplePerspective } from "../../core/matrix";
import { DonutFirstPersonCamera } from "../../core/donut_first_person_camera";

namespace MultiDrawIndirectNri {
    // multi_draw_indirect, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (multi_draw_indirect.hlsl's), scene (read as Donut's
    // loadGltfModel reads it) and textures, through the NRI calls core/nri/nri_interop.d.ts binds,
    // with NRIFramework's ImGui for the sample's overlay. This example creates everything it runs,
    // and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): D3D11.
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Multi-Draw Indirect";

    // The sample's scene (Vulkan-Samples' assets): a glTF file whose meshes each have a texture
    // named after them, the KTX textures converted to DDS at build time (see
    // VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const SCENE_DIR = "media/multi_draw_indirect/vokselia/";
    const SCENE_PATH = SCENE_DIR + "vokselia.gltf";
    // The shaders' texture array (TEXTURE_COUNT in multi_draw_indirect.hlsl): one per mesh.
    const TEXTURE_COUNT = 225;

    // Nri_LoadGltfModel's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_FLOATS = 8;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;
    const TEXCOORD_OFFSET = 24;
    // struct GpuModelInformation { vec3 bounding_sphere_center; float bounding_sphere_radius;
    // uint texture_index, firstIndex, indexCount, _pad; }
    const MODEL_INFORMATION_FLOATS = 8;
    const MODEL_INFORMATION_SIZE = MODEL_INFORMATION_FLOATS * 4;
    const TEXTURE_INDEX_OFFSET = 16;
    // struct VkDrawIndexedIndirectCommand { uint indexCount, instanceCount, firstIndex;
    // int vertexOffset; uint firstInstance; }
    const COMMAND_INTS = 5;
    const COMMAND_SIZE = COMMAND_INTS * 4;
    const COMMAND_INSTANCE_COUNT = 1;

    // struct SceneUniform { mat4 view, proj, proj_view; uint model_count; }, as f32 offsets, padded
    // to 16 bytes; a queued frame's each in a constant buffer view of CONST_VIEW_SIZE bytes.
    const CONST_VIEW = 0;
    const CONST_PROJ = 16;
    const CONST_PROJ_VIEW = 32;
    const CONST_MODEL_COUNT = 48;
    const CONST_FLOATS = 52;
    const CONST_VIEW_SIZE = 256;

    // The sample's camera: depth from 0.001 to 512.
    const Z_NEAR = 0.001;
    const Z_FAR = 512.0;

    // The culling's workgroup size (cull_cs's numthreads).
    const CULL_GROUP_SIZE = 64;

    // The sample's clear color (linear, into an sRGB target).
    const CLEAR_COLOR = 0.002;

    // The sample's RenderMode: who culls the models.
    enum RenderPath {
        Cpu = 0,
        Gpu = 1,
        GpuDeviceAddress = 2
    }
    const RENDER_MODE_NAMES = "CPU|GPU|GPU Device Address";

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // -test: checks the last frame and the culling, as the Donut example does. The top corners are
    // the dark clear color, the scene covers about half the frame (35% to 80% not near black); the
    // GPU culling kept some of the instances, not all.
    function checkFrame(pixels: int[], width: int, height: int, instanceCount: int, modelCount: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        if ((pixels[0] & 0xFFFFFF) != 0x070707 || (pixels[width - 1] & 0xFFFFFF) != 0x070707) {
            return "the top corners aren't the clear color";
        }
        const total = width * height;
        let dark = 0;
        for (let i = 0; i < total; i++) {
            const p = pixels[i];
            if ((p & 0xFF) <= 20 && ((p >> 8) & 0xFF) <= 20 && ((p >> 16) & 0xFF) <= 20) {
                dark++;
            }
        }
        const percent = 100.0 * (total - dark) / total;
        console.log(`Scene: ${percent}% (${total - dark} of ${total} pixels)`);
        if (percent < 35.0 || percent > 80.0) {
            return `Scene: ${percent}% of the pixels, not 35% to 80%`;
        }
        console.log(`Instances: ${instanceCount} of ${modelCount}`);
        if (instanceCount <= 0 || instanceCount >= modelCount) {
            return `${instanceCount} of ${modelCount} instances visible: the culling kept none or all`;
        }
        return "";
    }

    // The sample's VisibilityTester (see https://www.gamedevs.org/uploads/fast-extraction-viewing-frustum-planes-from-world-view-projection-matrix.pdf):
    // a bounding sphere against the frustum planes of a projection-view matrix (glm's layout),
    // the left, right, near and far ones.
    class VisibilityTester {
        planes: number[] = [];

        constructor(mat: f32[], offset: int) {
            // out[2 * i + j][k] = mat[k][3] + sign * mat[k][i]
            for (let i = 0; i < 3; i++) {
                for (let j = 0; j < 2; j++) {
                    const sign = j > 0 ? 1.0 : -1.0;
                    for (let k = 0; k < 4; k++) {
                        this.planes.push(mat[offset + k * 4 + 3] + sign * mat[offset + k * 4 + i]);
                    }
                }
            }

            // normalize plane; see Appendix A.2
            for (let p = 0; p < 6; p++) {
                const x = this.planes[p * 4];
                const y = this.planes[p * 4 + 1];
                const z = this.planes[p * 4 + 2];
                const length = Math.sqrt(x * x + y * y + z * z);
                for (let k = 0; k < 4; k++) {
                    this.planes[p * 4 + k] /= length;
                }
            }
        }

        isVisible(x: number, y: number, z: number, radius: number) {
            const tested = [0, 1, 4, 5];
            for (const planeIndex of tested) {
                const p = planeIndex * 4;
                const plane = this.planes;
                if (x * plane[p] + y * plane[p + 1] + z * plane[p + 2] + plane[p + 3] + radius < 0.0) {
                    return false;
                }
            }
            return true;
        }
    }

    // What a frame in flight records into, its constants' view, its descriptor sets (the draw's;
    // the culling's; the device address culling's, null without it), the CPU culling's commands it
    // uploads, and the copy of the commands it reads the instance count from.
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public constantBufferView: NriDescriptorHandle, public drawSet: NriDescriptorSetHandle,
            public cullSet: NriDescriptorSetHandle, public addressSet: NriDescriptorSetHandle | null,
            public hostCommands: NriBufferHandle, public readback: NriBufferHandle, public readbackValid: boolean) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // Port of Vulkan-Samples' multi_draw_indirect (as examples/multi_draw_indirect.ts ports it) to
    // NRI: a scene of 225 meshes, each with its own texture, in one vertex and one index buffer,
    // drawn by one indirect draw call of a draw per mesh (or a call per mesh). Each draw's instance
    // count makes it visible or not: frustum culling of the meshes' bounding spheres sets it, on the
    // CPU, or on the GPU in a compute shader writing the draws' buffer through its binding or
    // (Vulkan) its device address. Each draw's first instance reads its mesh's texture index from a
    // per-instance vertex buffer.
    class MultiDrawIndirect {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private depthTexture: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private drawLayout: NriPipelineLayoutHandle | null = null;
        private cullLayout: NriPipelineLayoutHandle | null = null;
        private addressLayout: NriPipelineLayoutHandle | null = null;
        private drawPipeline: NriPipelineHandle | null = null;
        private cullPipeline: NriPipelineHandle | null = null;
        // Null without buffer device addresses (then the frames' address sets are null too).
        private addressPipeline: NriPipelineHandle | null = null;
        private textures: NriTextureHandle[] = [];
        private textureViews: NriDescriptorHandle[] = [];
        private sampler: NriDescriptorHandle | null = null;
        private constantBuffer: NriBufferHandle | null = null;
        private vertexBuffer: NriBufferHandle | null = null;
        private indexBuffer: NriBufferHandle | null = null;
        // The models' information: per instance (a vertex buffer), and for the culling (a raw buffer).
        private modelInstanceBuffer: NriBufferHandle | null = null;
        private modelInformationBuffer: NriBufferHandle | null = null;
        private modelInformationView: NriDescriptorHandle | null = null;
        // The draws' commands, read by the indirect draws, written by the culling (a raw buffer); in
        // NriBufferState.IndirectArgument between the passes.
        private indirectCallBuffer: NriBufferHandle | null = null;
        private indirectCallStorage: NriDescriptorHandle | null = null;
        // The address of the commands' buffer, for the device address culling.
        private addressBuffer: NriBufferHandle | null = null;
        private addressView: NriDescriptorHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        private camera: DonutFirstPersonCamera = new DonutFirstPersonCamera(1.0, radians(1.0));

        // The sample's settings: -nomdi (a draw call per model), -freeze (culling frozen), -mode
        // <0..2> (the cull mode: CPU, GPU, GPU device address); -noUI: no overlay.
        enableMdi: boolean = true;
        freezeCull: boolean = false;
        renderMode: int = RenderPath.Gpu;
        noUI: boolean = false;
        // What the device has: draws per indirect call above 1, buffer device addresses (the device
        // address culling).
        private multiDraw: boolean = false;
        private deviceAddress: boolean = false;
        // Visible models, as last counted, and all of them.
        instanceCount: int = 0;
        modelCount: int = 0;

        // The models' bounding spheres (x, y, z, radius each), and their draws' commands (as ints,
        // and as the f32 words uploaded).
        private spheres: number[] = [];
        private commands: int[] = [];
        private commandWords: f32[] = [];
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
            if (this.unsupportedReason != "") {
                const test = Nri_IsTest(this.sample) != 0;
                console.log(test ? `Test SKIPPED: ${this.unsupportedReason}` : this.unsupportedReason);
                result = test ? TEST_SKIPPED : 1;
            } else if (result == 0 && this.test) {
                const pixels = this.readBack();
                this.countReadBackInstances();
                const failure = checkFrame(pixels, this.width, this.height, this.instanceCount, this.modelCount);
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

            // The scene's 225 textures are one array: more than D3D11's 128 texture slots (and the
            // shaders are DXIL and SPIR-V only).
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "This example needs D3D12 or Vulkan (225 textures in one array)";
                return 0;
            }
            this.multiDraw = Nri_GetDrawIndirectMaxNum(device) > 1;

            // The depth buffer: D32, cleared to 1.
            const depthTexture = Nri_CreateDepthTexture(device, this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
                console.log("Cannot create the depth buffer");
                return 0;
            }
            this.depthAttachment = Nri_CreateDepthAttachmentView(depthTexture, NriFormat.D32_SFLOAT);

            // The sample's linear sampler (repeat): Donut's LinearWrap.
            this.sampler = Nri_CreateSamplerWithMipFilter(device, NriFilter.Linear, NriFilter.Linear, NriAddressMode.Repeat, 1);
            if (!this.sampler || !this.loadScene(device)) {
                console.log("Cannot load the scene and its textures: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }

            // The draws' commands, all visible until culled: indirect arguments, written by the
            // culling (raw).
            const indirectCallBuffer = Nri_CreateStorageBufferFromInts(device, this.queue, Ref(this.commands[0]), this.modelCount * COMMAND_SIZE,
                4, NriBufferState.IndirectArgument);
            this.indirectCallBuffer = indirectCallBuffer;
            if (!indirectCallBuffer) {
                console.log("Cannot create the commands' buffer");
                return 0;
            }
            this.indirectCallStorage = Nri_CreateStructuredBufferView(indirectCallBuffer, 1);

            // The address of the commands' buffer, in a buffer of its own, for the device address
            // culling (Vulkan).
            const address: f32[] = [0.0, 0.0];
            if (Nri_GetBufferDeviceAddress(device, indirectCallBuffer, Ref(address[0])) != 0) {
                const addressBuffer = Nri_CreateUploadedStructuredBuffer(device, this.queue, Ref(address[0]), 8, 8);
                this.addressBuffer = addressBuffer;
                if (addressBuffer) {
                    this.addressView = Nri_CreateStructuredBufferView(addressBuffer, 0);
                }
            }

            if (!this.createPipelines(device, graphicsAPI)) {
                return 0;
            }
            if (!this.createFrames(device, queuedFrameNum)) {
                return 0;
            }

            // The sample's first person camera, rotated (-23.5, -45, 0) degrees and translated by
            // (0, 0.5, -0.2): its view matrix is Rx * Ry * T, so it's at -(0, 0.5, -0.2), looking down
            // R^T * (0, 0, -1). In Donut's world (see writeConstants), y negated. One degree per
            // pixel of mouse movement and one unit per second, as its camera.
            const sa = Math.sin(radians(-23.5));
            const ca = Math.cos(radians(-23.5));
            const sb = Math.sin(radians(-45.0));
            const cb = Math.cos(radians(-45.0));
            const position = [0.0, -0.5, 0.2];
            const forward = [ca * sb, -sa, -ca * cb];
            this.camera.lookAt(position[0], -position[1], position[2],
                position[0] + forward[0], -(position[1] + forward[1]), position[2] + forward[2]);

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

        // The sample's load_scene and initialize_resources: each mesh's texture, and its vertices and
        // triangles in one vertex and one index buffer. As the sample, the vertices are mirrored in y
        // (into its world), but not the bounding spheres, computed from the vertices as read: so its
        // culling tests mirrored spheres.
        loadScene(device: NriDeviceHandle) {
            const scene = Nri_LoadGltfModel(SCENE_PATH);
            if (!scene) {
                return false;
            }
            this.modelCount = Nri_GetGltfModelPrimitiveCount(scene);
            if (this.modelCount != TEXTURE_COUNT) {
                console.log(`${SCENE_PATH} has ${this.modelCount} meshes, the shaders expect ${TEXTURE_COUNT}`);
                Nri_DestroyGltfModel(scene);
                return false;
            }

            const vertices: f32[] = [];
            const indices: int[] = [];
            const modelInformation: f32[] = [];
            let loaded = true;
            for (let p = 0; p < this.modelCount; p++) {
                // As the sample (vkb) loads KTX 1 color textures: as sRGB. One mip level, as the sample's.
                const texture = Nri_LoadDdsTexture(device, this.queue, SCENE_DIR + Nri_GetGltfModelMeshName(scene, p) + ".dds", 1);
                if (!texture) {
                    loaded = false;
                    break;
                }
                this.textures.push(texture);
                this.textureViews.push(Nri_CreateTextureView(texture, NriFormat.RGBA8_SRGB));

                const vertexCount = Nri_GetGltfModelVertexCount(scene, p);
                const indexCount = Nri_GetGltfModelIndexCount(scene, p);
                const modelVertices: f32[] = [];
                for (let i = 0; i < vertexCount * VERTEX_FLOATS; i++) {
                    modelVertices.push(0.0);
                }
                const modelIndices: int[] = [];
                for (let i = 0; i < indexCount; i++) {
                    modelIndices.push(0);
                }
                Nri_CopyGltfModelVertices(scene, p, Ref(modelVertices[0]));
                Nri_CopyGltfModelIndices(scene, p, Ref(modelIndices[0]));

                const firstVertex = vertices.length / VERTEX_FLOATS;
                const firstIndex = indices.length;

                // The sample's BoundingSphere: the points' average and the farthest point from it
                // (plus one float ulp).
                let cx = 0.0;
                let cy = 0.0;
                let cz = 0.0;
                for (let v = 0; v < vertexCount * VERTEX_FLOATS; v += VERTEX_FLOATS) {
                    cx += modelVertices[v];
                    cy += modelVertices[v + 1];
                    cz += modelVertices[v + 2];
                }
                cx /= vertexCount;
                cy /= vertexCount;
                cz /= vertexCount;
                let radius2 = 0.0;
                for (let v = 0; v < vertexCount * VERTEX_FLOATS; v += VERTEX_FLOATS) {
                    const dx = modelVertices[v] - cx;
                    const dy = modelVertices[v + 1] - cy;
                    const dz = modelVertices[v + 2] - cz;
                    radius2 = Math.max(radius2, dx * dx + dy * dy + dz * dz);
                }
                const radius = Math.sqrt(radius2) * (1.0 + 1.0 / 8388608.0);
                this.spheres.push(cx);
                this.spheres.push(cy);
                this.spheres.push(cz);
                this.spheres.push(radius);

                for (let v = 0; v < vertexCount * VERTEX_FLOATS; v++) {
                    const isY = v % VERTEX_FLOATS == 1;
                    vertices.push(isY ? -modelVertices[v] : modelVertices[v]);
                }
                for (let i = 0; i < indexCount; i++) {
                    indices.push(modelIndices[i]);
                }

                // The model's information, read per instance by the vertex shader (each draw's first
                // instance is its model) and by the culling. Its indexCount is the triangle count,
                // as the sample's (nothing reads it).
                modelInformation.push(cx);
                modelInformation.push(cy);
                modelInformation.push(cz);
                modelInformation.push(radius);
                for (let k = 0; k < 4; k++) {
                    modelInformation.push(0.0);
                }
                const info = p * MODEL_INFORMATION_FLOATS;
                Nri_StoreInt32(Ref(modelInformation[info + 4]), p);
                Nri_StoreInt32(Ref(modelInformation[info + 5]), firstIndex);
                Nri_StoreInt32(Ref(modelInformation[info + 6]), indexCount / 3);

                // The model's draw: its triangles, one instance until culled.
                this.commands.push(indexCount);
                this.commands.push(1);
                this.commands.push(firstIndex);
                this.commands.push(firstVertex);
                this.commands.push(p);
            }
            Nri_DestroyGltfModel(scene);
            if (!loaded) {
                return false;
            }
            for (let i = 0; i < this.commands.length; i++) {
                this.commandWords.push(0.0);
                Nri_StoreInt32(Ref(this.commandWords[i]), this.commands[i]);
            }

            this.vertexBuffer = Nri_CreateUploadedBuffer(device, this.queue, Ref(vertices[0]), vertices.length * 4, NriBufferUsage.VertexBuffer);
            this.indexBuffer = Nri_CreateUploadedBufferFromInts(device, this.queue, Ref(indices[0]), indices.length * 4, NriBufferUsage.IndexBuffer);
            this.modelInstanceBuffer = Nri_CreateUploadedBuffer(device, this.queue, Ref(modelInformation[0]),
                this.modelCount * MODEL_INFORMATION_SIZE, NriBufferUsage.VertexBuffer);
            const modelInformationBuffer = Nri_CreateUploadedStructuredBuffer(device, this.queue, Ref(modelInformation[0]),
                this.modelCount * MODEL_INFORMATION_SIZE, 4);
            this.modelInformationBuffer = modelInformationBuffer;
            if (!this.vertexBuffer || !this.indexBuffer || !this.modelInstanceBuffer || !modelInformationBuffer) {
                return false;
            }
            this.modelInformationView = Nri_CreateStructuredBufferView(modelInformationBuffer, 0);
            return true;
        }

        // The layouts and pipelines: the draw (the scene uniform, the array of textures, accessed via
        // the instance's texture index, and their sampler; depth test (less), back faces culled,
        // counter-clockwise front faces, in the sample's clip space); the culling (the scene uniform,
        // the models' information, the commands); with device addresses, the culling through the
        // commands' address instead of their binding.
        createPipelines(device: NriDeviceHandle, graphicsAPI: NriGraphicsAPI) {
            const drawLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(drawLayoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(drawLayoutDesc, 0, 0, TEXTURE_COUNT, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.Array);
            Nri_PipelineLayoutDescAddRange(drawLayoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            const drawLayout = Nri_CreatePipelineLayoutFromDesc(device, drawLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(drawLayoutDesc);
            this.drawLayout = drawLayout;

            const cullLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(cullLayoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Compute, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(cullLayoutDesc, 0, 0, 1, NriDescriptorType.StructuredBuffer, NriStage.Compute, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(cullLayoutDesc, 0, 0, 1, NriDescriptorType.StorageStructuredBuffer, NriStage.Compute, NriRangeFlags.None);
            const cullLayout = Nri_CreatePipelineLayoutFromDesc(device, cullLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(cullLayoutDesc);
            this.cullLayout = cullLayout;
            if (!drawLayout || !cullLayout) {
                console.log("Cannot create the pipeline layouts");
                return false;
            }

            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/multi_draw_indirect/${folder}/multi_draw_indirect`;
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_mdi_vs.bin`, "mdi_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_mdi_ps.bin`, "mdi_ps") != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescAddVertexAttribute(desc, "TEXCOORD", NriFormat.RG32_SFLOAT, TEXCOORD_OFFSET);
            Nri_PipelineDescAddVertexAttributeFromStream(desc, "TEXTURE_INDEX", NriFormat.R32_UINT, TEXTURE_INDEX_OFFSET, 1);
            Nri_PipelineDescSetInstanceStream(desc, 1);
            Nri_PipelineDescSetCullMode(desc, NriCullMode.Back);
            Nri_PipelineDescSetFrontCounterClockwise(desc, 1);
            Nri_PipelineDescSetColor(desc, this.viewFormat, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.Less, 1, 0);
            if (loaded) {
                this.drawPipeline = Nri_CreatePipelineFromDesc(device, drawLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            this.cullPipeline = Nri_CreateComputePipeline(device, cullLayout, `${shaders}_cull_cs.bin`, "cull_cs");
            if (!this.drawPipeline || !this.cullPipeline) {
                console.log("Cannot load the multi-draw indirect shaders");
                return false;
            }

            // The device address culling (Vulkan): the commands through the references from the
            // device addresses, instead of their binding.
            if (!this.addressView) {
                return true;
            }
            const addressLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(addressLayoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Compute, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(addressLayoutDesc, 0, 0, 1, NriDescriptorType.StructuredBuffer, NriStage.Compute, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(addressLayoutDesc, 0, 1, 1, NriDescriptorType.StructuredBuffer, NriStage.Compute, NriRangeFlags.None);
            const addressLayout = Nri_CreatePipelineLayoutFromDesc(device, addressLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(addressLayoutDesc);
            this.addressLayout = addressLayout;
            if (!addressLayout) {
                console.log("Cannot create the pipeline layouts");
                return false;
            }
            this.addressPipeline = Nri_CreateComputePipeline(device, addressLayout, `${shaders}_cull_address_cs.bin`, "cull_address_cs");
            if (!this.addressPipeline) {
                console.log("Cannot load the multi-draw indirect shaders");
                return false;
            }
            this.deviceAddress = true;
            return true;
        }

        // The constants (a queued frame's each), the queued frames and their descriptor sets, the CPU
        // culling's commands to upload and the commands' readback copies.
        createFrames(device: NriDeviceHandle, queuedFrameNum: int) {
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * CONST_VIEW_SIZE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const descriptorPool = Nri_CreateDescriptorPoolWithBuffers(device, 3 * queuedFrameNum, queuedFrameNum, 3 * queuedFrameNum,
                TEXTURE_COUNT * queuedFrameNum, 0, 3 * queuedFrameNum, queuedFrameNum, 0);
            this.descriptorPool = descriptorPool;
            const drawLayout = this.drawLayout;
            const cullLayout = this.cullLayout;
            const sampler = this.sampler;
            const modelInformationView = this.modelInformationView;
            const indirectCallStorage = this.indirectCallStorage;
            if (!constantBuffer || !descriptorPool || !drawLayout || !cullLayout || !sampler || !modelInformationView || !indirectCallStorage) {
                console.log("Cannot create the descriptors");
                return false;
            }
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const constantBufferView = Nri_CreateConstantBufferView(constantBuffer, i * CONST_VIEW_SIZE, CONST_VIEW_SIZE);
                const drawSet = Nri_AllocateDescriptorSet(descriptorPool, drawLayout, 0, 0);
                const cullSet = Nri_AllocateDescriptorSet(descriptorPool, cullLayout, 0, 0);
                const hostCommands = Nri_CreateHostBufferWithStride(device, this.modelCount * COMMAND_SIZE, NriBufferUsage.StructuredBuffer, 4);
                const readback = Nri_CreateReadbackBuffer(device, this.modelCount * COMMAND_SIZE);
                if (!constantBufferView || !drawSet || !cullSet || !hostCommands || !readback) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                Nri_UpdateDescriptor(drawSet, 0, 0, constantBufferView);
                for (let t = 0; t < TEXTURE_COUNT; t++) {
                    Nri_UpdateDescriptor(drawSet, 1, t, this.textureViews[t]);
                }
                Nri_UpdateDescriptor(drawSet, 2, 0, sampler);
                Nri_UpdateDescriptor(cullSet, 0, 0, constantBufferView);
                Nri_UpdateDescriptor(cullSet, 1, 0, modelInformationView);
                Nri_UpdateDescriptor(cullSet, 2, 0, indirectCallStorage);
                const addressSet = this.createAddressSet(descriptorPool, constantBufferView, modelInformationView);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), constantBufferView,
                    drawSet, cullSet, addressSet, hostCommands, readback, false));
            }
            return true;
        }

        // A queued frame's device address culling set: its constants, the models' information and
        // the commands' address; null without device addresses.
        createAddressSet(descriptorPool: NriDescriptorPoolHandle, constantBufferView: NriDescriptorHandle,
            modelInformationView: NriDescriptorHandle): NriDescriptorSetHandle | null {
            const addressLayout = this.addressLayout;
            const addressView = this.addressView;
            if (!addressLayout || !addressView) {
                return null;
            }
            const addressSet = Nri_AllocateDescriptorSet(descriptorPool, addressLayout, 0, 0);
            if (!addressSet) {
                return null;
            }
            Nri_UpdateDescriptor(addressSet, 0, 0, constantBufferView);
            Nri_UpdateDescriptor(addressSet, 1, 0, modelInformationView);
            Nri_UpdateDescriptor(addressSet, 2, 0, addressView);
            return addressSet;
        }

        // Waits for the frame that last used this frame's command allocator (and its constants and
        // copies), then counts the instances its copy of the commands holds (the GPU culling's).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
            if (this.renderMode != RenderPath.Cpu && queuedFrame.readbackValid) {
                this.countInstances(queuedFrame.readback);
            }
        }

        // The visible models in a copy of the commands.
        countInstances(readback: NriBufferHandle) {
            const commands: int[] = [];
            for (let i = 0; i < this.modelCount * COMMAND_INTS; i++) {
                commands.push(0);
            }
            if (Nri_ReadBufferInts(readback, Ref(commands[0]), commands.length) == 0) {
                return;
            }
            let visible = 0;
            for (let i = 0; i < this.modelCount; i++) {
                visible += commands[i * COMMAND_INTS + COMMAND_INSTANCE_COUNT];
            }
            this.instanceCount = visible;
        }

        // The test's count: the last frame's copy (the device idle), with the GPU culling.
        countReadBackInstances() {
            const device = this.device;
            if (!device || this.renderMode == RenderPath.Cpu || this.queuedFrames.length == 0) {
                return;
            }
            Nri_DeviceWaitIdle(device);
            const queuedFrame = this.queuedFrames[(TEST_FRAMES - 1) % this.queuedFrames.length];
            if (queuedFrame.readbackValid) {
                this.countInstances(queuedFrame.readback);
            }
        }

        // The sample's update_scene_uniform: its camera's view and projection matrices, and the
        // number of models, into this frame's constants.
        writeConstants(queuedFrameIndex: int) {
            const constantBuffer = this.constantBuffer;
            if (!constantBuffer) {
                return;
            }
            const viewMatrix = this.camera.worldToView();

            // The sample's world has -y up on the screen. Mirrored in y it is Donut's world, y up,
            // with the same picture: Donut's world is right-handed, its view space left-handed. So
            // the sample's view matrix is the y mirror, then Donut's view, then Donut's view space
            // to the sample's (y down, -z forward): rows and columns of Donut's negated. Donut's
            // row-vector matrices have glm's (column-vector) layout.
            const c = this.constants;
            for (let i = 0; i < 16; i++) {
                const row = Math.floor(i / 4);
                const column = i % 4;
                const mirrored = row == 1 ? -viewMatrix[i] : viewMatrix[i];
                c[CONST_VIEW + i] = column == 1 || column == 2 ? -mirrored : mirrored;
            }

            const projection = samplePerspective(radians(60.0), this.width / this.height, Z_NEAR, Z_FAR);
            for (let i = 0; i < 16; i++) {
                c[CONST_PROJ + i] = projection[i];
            }

            // proj_view = proj * view, glm's layout: element (column, row) at column * 4 + row.
            for (let column = 0; column < 4; column++) {
                for (let row = 0; row < 4; row++) {
                    let sum = 0.0;
                    for (let k = 0; k < 4; k++) {
                        sum += c[CONST_PROJ + k * 4 + row] * c[CONST_VIEW + column * 4 + k];
                    }
                    c[CONST_PROJ_VIEW + column * 4 + row] = sum;
                }
            }

            Nri_StoreInt32(Ref(c[CONST_MODEL_COUNT]), this.modelCount);
            Nri_WriteBuffer(constantBuffer, queuedFrameIndex * CONST_VIEW_SIZE, Ref(c[0]), CONST_FLOATS * 4);
        }

        // The sample's cpu_cull: every model's draw, visible (one instance) or not (none).
        cpuCull() {
            const tester = new VisibilityTester(this.constants, CONST_PROJ_VIEW);
            let visible = 0;
            for (let i = 0; i < this.modelCount; i++) {
                const s = i * 4;
                const isVisible = tester.isVisible(this.spheres[s], this.spheres[s + 1], this.spheres[s + 2], this.spheres[s + 3]);
                // we control visibility by changing the instance count
                const word = i * COMMAND_INTS + COMMAND_INSTANCE_COUNT;
                this.commands[word] = isVisible ? 1 : 0;
                Nri_StoreInt32(Ref(this.commandWords[word]), this.commands[word]);
                if (isVisible) {
                    visible++;
                }
            }
            this.instanceCount = visible;
        }

        // The CPU culling's commands, uploaded into the commands' buffer (outside rendering).
        recordUpload(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const indirectCallBuffer = this.indirectCallBuffer;
            if (!indirectCallBuffer) {
                return;
            }
            const byteSize = this.modelCount * COMMAND_SIZE;
            Nri_WriteBuffer(queuedFrame.hostCommands, 0, Ref(this.commandWords[0]), byteSize);
            Nri_CmdBufferBarrier(commandBuffer, indirectCallBuffer, NriBufferState.IndirectArgument, NriBufferState.CopyDestination);
            Nri_CmdCopyBuffer(commandBuffer, indirectCallBuffer, queuedFrame.hostCommands, byteSize);
            Nri_CmdBufferBarrier(commandBuffer, indirectCallBuffer, NriBufferState.CopyDestination, NriBufferState.IndirectArgument);
        }

        // The sample's run_gpu_cull: a thread per model, writing the commands through their binding
        // or (GpuDeviceAddress) their address (outside rendering).
        recordGpuCull(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const indirectCallBuffer = this.indirectCallBuffer;
            const cullLayout = this.cullLayout;
            const cullPipeline = this.cullPipeline;
            if (!indirectCallBuffer || !cullLayout || !cullPipeline) {
                return;
            }
            const groups = Math.floor((this.modelCount + CULL_GROUP_SIZE - 1) / CULL_GROUP_SIZE);
            Nri_CmdBufferBarrier(commandBuffer, indirectCallBuffer, NriBufferState.IndirectArgument, NriBufferState.Storage);
            if (!this.recordAddressCull(commandBuffer, queuedFrame, groups)) {
                Nri_CmdSetComputePipelineLayout(commandBuffer, cullLayout);
                Nri_CmdSetPipeline(commandBuffer, cullPipeline);
                Nri_CmdSetComputeDescriptorSet(commandBuffer, 0, queuedFrame.cullSet);
                Nri_CmdDispatch(commandBuffer, groups, 1, 1);
            }
            Nri_CmdBufferBarrier(commandBuffer, indirectCallBuffer, NriBufferState.Storage, NriBufferState.IndirectArgument);
        }

        // The device address culling, in GpuDeviceAddress mode with device addresses; false if not.
        recordAddressCull(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame, groups: int) {
            const addressLayout = this.addressLayout;
            const addressPipeline = this.addressPipeline;
            const addressSet = queuedFrame.addressSet;
            if (this.renderMode != RenderPath.GpuDeviceAddress || !addressLayout || !addressPipeline || !addressSet) {
                return false;
            }
            Nri_CmdSetComputePipelineLayout(commandBuffer, addressLayout);
            Nri_CmdSetPipeline(commandBuffer, addressPipeline);
            Nri_CmdSetComputeDescriptorSet(commandBuffer, 0, addressSet);
            Nri_CmdDispatch(commandBuffer, groups, 1, 1);
            return true;
        }

        // The sample's overlay counts the instances the GPU culling left: from a copy of the commands
        // the queued frame reads when its turn comes back (latencySleep).
        recordCommandsCopy(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const indirectCallBuffer = this.indirectCallBuffer;
            if (!indirectCallBuffer) {
                return;
            }
            Nri_CmdBufferBarrier(commandBuffer, indirectCallBuffer, NriBufferState.IndirectArgument, NriBufferState.CopySource);
            Nri_CmdCopyBuffer(commandBuffer, queuedFrame.readback, indirectCallBuffer, this.modelCount * COMMAND_SIZE);
            Nri_CmdBufferBarrier(commandBuffer, indirectCallBuffer, NriBufferState.CopySource, NriBufferState.IndirectArgument);
            queuedFrame.readbackValid = true;
        }

        // The scene: one indirect call of a draw per model, or a call per model (between
        // Nri_CmdBeginRenderingWithDepth and Nri_CmdEndRendering).
        recordDraw(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const descriptorPool = this.descriptorPool;
            const drawLayout = this.drawLayout;
            const drawPipeline = this.drawPipeline;
            const vertexBuffer = this.vertexBuffer;
            const indexBuffer = this.indexBuffer;
            const modelInstanceBuffer = this.modelInstanceBuffer;
            const indirectCallBuffer = this.indirectCallBuffer;
            if (!descriptorPool || !drawLayout || !drawPipeline || !vertexBuffer || !indexBuffer || !modelInstanceBuffer
                || !indirectCallBuffer) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, drawLayout);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, queuedFrame.drawSet);
            Nri_CmdSetPipeline(commandBuffer, drawPipeline);
            Nri_CmdSetIndexBuffer(commandBuffer, indexBuffer, 0, NriIndexType.UInt32);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, vertexBuffer, 0, VERTEX_SIZE);
            Nri_CmdSetVertexBuffer(commandBuffer, 1, modelInstanceBuffer, 0, MODEL_INFORMATION_SIZE);
            if (this.enableMdi && this.multiDraw) {
                Nri_CmdDrawIndexedIndirect(commandBuffer, indirectCallBuffer, 0, this.modelCount, COMMAND_SIZE, null, 0);
            } else {
                for (let j = 0; j < this.modelCount; j++) {
                    Nri_CmdDrawIndexedIndirect(commandBuffer, indirectCallBuffer, j * COMMAND_SIZE, 1, COMMAND_SIZE, null, 0);
                }
            }
        }

        // The sample's overlay (its title, ApiVulkanSample's default).
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPos(10.0, 10.0);
            Nri_ImguiBegin("Vulkan Example", 1);
            if (Nri_ImguiCollapsingHeader("GPU Rendering", 1) != 0) {
                Nri_ImguiText(`Multi-Draw Indirect: ${this.multiDraw ? "Supported" : "Not supported"}`);
                Nri_ImguiText("drawIndirectFirstInstance: Supported");
                Nri_ImguiText(`Device buffer address: ${this.deviceAddress ? "Supported" : "Not supported"}`);

                Nri_ImguiText("");
                Nri_ImguiText(`Instances: ${this.instanceCount} / ${this.modelCount}`);

                this.enableMdi = Nri_ImguiCheckbox("Enable multi-draw", this.enableMdi ? 1 : 0) != 0;
                this.freezeCull = Nri_ImguiCheckbox("Freeze culling", this.freezeCull ? 1 : 0) != 0;
                this.renderMode = Nri_ImguiCombo("Cull mode", this.renderMode, RENDER_MODE_NAMES);
            }
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            if (this.renderMode == RenderPath.GpuDeviceAddress && !this.deviceAddress) {
                this.renderMode = RenderPath.Gpu;
            }
            const mouseFree = !this.imgui || Nri_ImguiWantsMouse() == 0;
            this.camera.animate(this.sample, this.test ? Math.fround(1.0 / 60.0) : Nri_GetFrameTime(this.sample), mouseFree);
            this.writeConstants(queuedFrameIndex);
            if (!this.freezeCull && this.renderMode == RenderPath.Cpu) {
                this.cpuCull();
            }

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            const depthAttachment = this.depthAttachment;
            const descriptorPool = this.descriptorPool;
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: the culling (the CPU's commands uploaded, or the GPU's), the copy of the
                // commands, then cleared, the scene, the overlay over it.
                Nri_BeginCommandBuffer(commandBuffer);
                if (this.imgui) {
                    Nri_CmdCopyImguiData(this.sample, commandBuffer);
                }
                if (descriptorPool) {
                    Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
                }
                if (!this.freezeCull) {
                    if (this.renderMode == RenderPath.Cpu) {
                        this.recordUpload(commandBuffer, queuedFrame);
                    } else {
                        this.recordGpuCull(commandBuffer, queuedFrame);
                    }
                }
                if (this.renderMode != RenderPath.Cpu) {
                    this.recordCommandsCopy(commandBuffer, queuedFrame);
                }
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    Nri_CmdBeginRenderingWithDepth(commandBuffer, swapChainTexture.colorAttachment, depthAttachment);
                    Nri_CmdClearColor(commandBuffer, CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
                    Nri_CmdClearDepth(commandBuffer, 1.0);
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
                    Nri_DestroyBuffer(queuedFrame.hostCommands);
                    Nri_DestroyBuffer(queuedFrame.readback);
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
                for (const view of this.textureViews) {
                    Nri_DestroyDescriptor(view);
                }
                for (const texture of this.textures) {
                    Nri_DestroyTexture(texture);
                }
                this.destroyDescriptor(this.sampler);
                this.destroyDescriptor(this.depthAttachment);
                this.destroyDescriptor(this.modelInformationView);
                this.destroyDescriptor(this.indirectCallStorage);
                this.destroyDescriptor(this.addressView);
                const depthTexture = this.depthTexture;
                if (depthTexture) {
                    Nri_DestroyTexture(depthTexture);
                }
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.indexBuffer);
                this.destroyBuffer(this.modelInstanceBuffer);
                this.destroyBuffer(this.modelInformationBuffer);
                this.destroyBuffer(this.indirectCallBuffer);
                this.destroyBuffer(this.addressBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.drawPipeline);
                this.destroyPipeline(this.cullPipeline);
                this.destroyPipeline(this.addressPipeline);
                this.destroyLayout(this.drawLayout);
                this.destroyLayout(this.cullLayout);
                this.destroyLayout(this.addressLayout);
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
        const mdi = new MultiDrawIndirect(sample);
        // -nomdi: a draw call per model; -freeze: culling frozen; -mode <0..2>: the cull mode (CPU,
        // GPU, GPU device address); -noUI: no overlay.
        Nri_AddExampleOption(sample, "-nomdi");
        Nri_AddExampleOption(sample, "-freeze");
        Nri_AddExampleOptionWithValues(sample, "-mode", 1);
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-nomdi") {
                mdi.enableMdi = false;
            } else if (arg == "-freeze") {
                mdi.freezeCull = true;
            } else if (arg == "-mode" && i + 1 < argc) {
                i++;
                mdi.renderMode = Math.min(Math.max(parseInt(Nri_GetArg(argc, argv, i)), RenderPath.Cpu), RenderPath.GpuDeviceAddress);
            } else if (arg == "-noUI") {
                mdi.noUI = true;
            }
        }
        return mdi.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return MultiDrawIndirectNri.main(argc, argv);
}

/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { radians, samplePerspective } from "../../core/matrix";
import { DonutFirstPersonCamera } from "../../core/donut_first_person_camera";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriGltfModel, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

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

    // NriGltfModel.load's vertices: float3 position, float3 normal, float2 texture coordinates.
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

    // A frame in flight's own data: its constants' view, its descriptor sets (the draw's;
    // the culling's; the device address culling's, null without it), the CPU culling's commands it
    // uploads, and the copy of the commands it reads the instance count from.
    class QueuedFrame {
        constructor(public constantBufferView: NriDescriptor, public drawSet: NriDescriptorSet,
            public cullSet: NriDescriptorSet, public addressSet: NriDescriptorSet | null,
            public hostCommands: NriBuffer, public readback: NriBuffer, public readbackValid: boolean) {
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
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        // The swap chain textures' format.
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private depthTexture: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
        private drawLayout: NriPipelineLayout | null = null;
        private cullLayout: NriPipelineLayout | null = null;
        private addressLayout: NriPipelineLayout | null = null;
        private drawPipeline: NriPipeline | null = null;
        private cullPipeline: NriPipeline | null = null;
        // Null without buffer device addresses (then the frames' address sets are null too).
        private addressPipeline: NriPipeline | null = null;
        private textures: NriTexture[] = [];
        private textureViews: NriDescriptor[] = [];
        private sampler: NriDescriptor | null = null;
        private constantBuffer: NriBuffer | null = null;
        private vertexBuffer: NriBuffer | null = null;
        private indexBuffer: NriBuffer | null = null;
        // The models' information: per instance (a vertex buffer), and for the culling (a raw buffer).
        private modelInstanceBuffer: NriBuffer | null = null;
        private modelInformationBuffer: NriBuffer | null = null;
        private modelInformationView: NriDescriptor | null = null;
        // The draws' commands, read by the indirect draws, written by the culling (a raw buffer); in
        // NriBufferState.IndirectArgument between the passes.
        private indirectCallBuffer: NriBuffer | null = null;
        private indirectCallStorage: NriDescriptor | null = null;
        // The address of the commands' buffer, for the device address culling.
        private addressBuffer: NriBuffer | null = null;
        private addressView: NriDescriptor | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
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
            if (this.unsupportedReason != "") {
                const test = this.sample.isTest() != 0;
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
            const device = this.sample.createDevice(graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri.getGraphicsAPIString(graphicsAPI)} (${device.getAdapterName()})`);

            this.queue = device.getGraphicsQueue();
            this.test = this.sample.isTest() != 0;

            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;

            // The scene's 225 textures are one array: more than D3D11's 128 texture slots (and the
            // shaders are DXIL and SPIR-V only).
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "This example needs D3D12 or Vulkan (225 textures in one array)";
                return 0;
            }
            this.multiDraw = device.getDrawIndirectMaxNum() > 1;

            if (!this.createDepth(device)) {
                console.log("Cannot create the depth buffer");
                return 0;
            }

            // The sample's linear sampler (repeat): Donut's LinearWrap.
            this.sampler = device.createSamplerWithMipFilter(NriFilter.Linear, NriFilter.Linear, NriAddressMode.Repeat, 1);
            if (!this.sampler || !this.loadScene(device)) {
                console.log("Cannot load the scene and its textures: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }

            // The draws' commands, all visible until culled: indirect arguments, written by the
            // culling (raw).
            const indirectCallBuffer = device.createStorageBufferFromInts(this.queue, Ref(this.commands[0]), this.modelCount * COMMAND_SIZE,
                4, NriBufferState.IndirectArgument);
            this.indirectCallBuffer = indirectCallBuffer;
            if (!indirectCallBuffer) {
                console.log("Cannot create the commands' buffer");
                return 0;
            }
            this.indirectCallStorage = indirectCallBuffer.createStructuredView(1);

            // The address of the commands' buffer, in a buffer of its own, for the device address
            // culling (Vulkan).
            const address: f32[] = [0.0, 0.0];
            if (device.getBufferAddress(indirectCallBuffer, Ref(address[0])) != 0) {
                const addressBuffer = device.createUploadedStructuredBuffer(this.queue, Ref(address[0]), 8, 8);
                this.addressBuffer = addressBuffer;
                if (addressBuffer) {
                    this.addressView = addressBuffer.createStructuredView(0);
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

        // The sample's load_scene and initialize_resources: each mesh's texture, and its vertices and
        // triangles in one vertex and one index buffer. As the sample, the vertices are mirrored in y
        // (into its world), but not the bounding spheres, computed from the vertices as read: so its
        // culling tests mirrored spheres.
        loadScene(device: NriDevice) {
            const scene = NriGltfModel.load(SCENE_PATH);
            if (!scene) {
                return false;
            }
            this.modelCount = scene.getPrimitiveCount();
            if (this.modelCount != TEXTURE_COUNT) {
                console.log(`${SCENE_PATH} has ${this.modelCount} meshes, the shaders expect ${TEXTURE_COUNT}`);
                scene.destroy();
                return false;
            }

            const vertices: f32[] = [];
            const indices: int[] = [];
            const modelInformation: f32[] = [];
            let loaded = true;
            for (let p = 0; p < this.modelCount; p++) {
                // As the sample (vkb) loads KTX 1 color textures: as sRGB. One mip level, as the sample's.
                const texture = device.loadDdsTexture(this.queue, SCENE_DIR + scene.getMeshName(p) + ".dds", 1);
                if (!texture) {
                    loaded = false;
                    break;
                }
                this.textures.push(texture);
                this.textureViews.push(texture.createView(NriFormat.RGBA8_SRGB));

                const vertexCount = scene.getVertexCount(p);
                const indexCount = scene.getIndexCount(p);
                const modelVertices: f32[] = [];
                for (let i = 0; i < vertexCount * VERTEX_FLOATS; i++) {
                    modelVertices.push(0.0);
                }
                const modelIndices: int[] = [];
                for (let i = 0; i < indexCount; i++) {
                    modelIndices.push(0);
                }
                scene.copyVertices(p, Ref(modelVertices[0]));
                scene.copyIndices(p, Ref(modelIndices[0]));

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
                Nri.storeInt32(Ref(modelInformation[info + 4]), p);
                Nri.storeInt32(Ref(modelInformation[info + 5]), firstIndex);
                Nri.storeInt32(Ref(modelInformation[info + 6]), indexCount / 3);

                // The model's draw: its triangles, one instance until culled.
                this.commands.push(indexCount);
                this.commands.push(1);
                this.commands.push(firstIndex);
                this.commands.push(firstVertex);
                this.commands.push(p);
            }
            scene.destroy();
            if (!loaded) {
                return false;
            }
            for (let i = 0; i < this.commands.length; i++) {
                this.commandWords.push(0.0);
                Nri.storeInt32(Ref(this.commandWords[i]), this.commands[i]);
            }

            this.vertexBuffer = device.createUploadedBuffer(this.queue, Ref(vertices[0]), vertices.length * 4, NriBufferUsage.VertexBuffer);
            this.indexBuffer = device.createUploadedBufferFromInts(this.queue, Ref(indices[0]), indices.length * 4, NriBufferUsage.IndexBuffer);
            this.modelInstanceBuffer = device.createUploadedBuffer(this.queue, Ref(modelInformation[0]),
                this.modelCount * MODEL_INFORMATION_SIZE, NriBufferUsage.VertexBuffer);
            const modelInformationBuffer = device.createUploadedStructuredBuffer(this.queue, Ref(modelInformation[0]),
                this.modelCount * MODEL_INFORMATION_SIZE, 4);
            this.modelInformationBuffer = modelInformationBuffer;
            if (!this.vertexBuffer || !this.indexBuffer || !this.modelInstanceBuffer || !modelInformationBuffer) {
                return false;
            }
            this.modelInformationView = modelInformationBuffer.createStructuredView(0);
            return true;
        }

        // The layouts and pipelines: the draw (the scene uniform, the array of textures, accessed via
        // the instance's texture index, and their sampler; depth test (less), back faces culled,
        // counter-clockwise front faces, in the sample's clip space); the culling (the scene uniform,
        // the models' information, the commands); with device addresses, the culling through the
        // commands' address instead of their binding.
        createPipelines(device: NriDevice, graphicsAPI: NriGraphicsAPI) {
            const drawLayoutDesc = NriPipelineLayoutDesc.create();
            drawLayoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            drawLayoutDesc.addRange(0, 0, TEXTURE_COUNT, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.Array);
            drawLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            const drawLayout = device.createPipelineLayoutFromDesc(drawLayoutDesc);
            drawLayoutDesc.destroy();
            this.drawLayout = drawLayout;

            const cullLayoutDesc = NriPipelineLayoutDesc.create();
            cullLayoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Compute, NriRangeFlags.None);
            cullLayoutDesc.addRange(0, 0, 1, NriDescriptorType.StructuredBuffer, NriStage.Compute, NriRangeFlags.None);
            cullLayoutDesc.addRange(0, 0, 1, NriDescriptorType.StorageStructuredBuffer, NriStage.Compute, NriRangeFlags.None);
            const cullLayout = device.createPipelineLayoutFromDesc(cullLayoutDesc);
            cullLayoutDesc.destroy();
            this.cullLayout = cullLayout;
            if (!drawLayout || !cullLayout) {
                console.log("Cannot create the pipeline layouts");
                return false;
            }

            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/multi_draw_indirect/${folder}/multi_draw_indirect`;
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_mdi_vs.bin`, "mdi_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_mdi_ps.bin`, "mdi_ps") != 0;
            }
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            desc.addVertexAttribute("TEXCOORD", NriFormat.RG32_SFLOAT, TEXCOORD_OFFSET);
            desc.addVertexAttributeFromStream("TEXTURE_INDEX", NriFormat.R32_UINT, TEXTURE_INDEX_OFFSET, 1);
            desc.setInstanceStream(1);
            desc.setCullMode(NriCullMode.Back);
            desc.setFrontCounterClockwise(1);
            desc.setColor(this.viewFormat, NriColorWrite.RGBA);
            desc.setDepth(NriFormat.D32_SFLOAT, NriCompareOp.Less, 1, 0);
            if (loaded) {
                this.drawPipeline = device.createPipelineFromDesc(drawLayout, desc);
            }
            desc.destroy();
            this.cullPipeline = device.createComputePipeline(cullLayout, `${shaders}_cull_cs.bin`, "cull_cs");
            if (!this.drawPipeline || !this.cullPipeline) {
                console.log("Cannot load the multi-draw indirect shaders");
                return false;
            }

            // The device address culling (Vulkan): the commands through the references from the
            // device addresses, instead of their binding.
            if (!this.addressView) {
                return true;
            }
            const addressLayoutDesc = NriPipelineLayoutDesc.create();
            addressLayoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Compute, NriRangeFlags.None);
            addressLayoutDesc.addRange(0, 0, 1, NriDescriptorType.StructuredBuffer, NriStage.Compute, NriRangeFlags.None);
            addressLayoutDesc.addRange(0, 1, 1, NriDescriptorType.StructuredBuffer, NriStage.Compute, NriRangeFlags.None);
            const addressLayout = device.createPipelineLayoutFromDesc(addressLayoutDesc);
            addressLayoutDesc.destroy();
            this.addressLayout = addressLayout;
            if (!addressLayout) {
                console.log("Cannot create the pipeline layouts");
                return false;
            }
            this.addressPipeline = device.createComputePipeline(addressLayout, `${shaders}_cull_address_cs.bin`, "cull_address_cs");
            if (!this.addressPipeline) {
                console.log("Cannot load the multi-draw indirect shaders");
                return false;
            }
            this.deviceAddress = true;
            return true;
        }

        // The constants (a queued frame's each), the queued frames and their descriptor sets, the CPU
        // culling's commands to upload and the commands' readback copies.
        createFrames(device: NriDevice, queuedFrameNum: int) {
            const constantBuffer = device.createHostBuffer(queuedFrameNum * CONST_VIEW_SIZE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const descriptorPool = device.createDescriptorPoolWithBuffers(3 * queuedFrameNum, queuedFrameNum, 3 * queuedFrameNum,
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
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const constantBufferView = constantBuffer.createConstantView(i * CONST_VIEW_SIZE, CONST_VIEW_SIZE);
                const drawSet = descriptorPool.allocateDescriptorSet(drawLayout, 0, 0);
                const cullSet = descriptorPool.allocateDescriptorSet(cullLayout, 0, 0);
                const hostCommands = device.createHostBufferWithStride(this.modelCount * COMMAND_SIZE, NriBufferUsage.StructuredBuffer, 4);
                const readback = device.createReadbackBuffer(this.modelCount * COMMAND_SIZE);
                if (!constantBufferView || !drawSet || !cullSet || !hostCommands || !readback) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                drawSet.updateDescriptor(0, 0, constantBufferView);
                for (let t = 0; t < TEXTURE_COUNT; t++) {
                    drawSet.updateDescriptor(1, t, this.textureViews[t]);
                }
                drawSet.updateDescriptor(2, 0, sampler);
                cullSet.updateDescriptor(0, 0, constantBufferView);
                cullSet.updateDescriptor(1, 0, modelInformationView);
                cullSet.updateDescriptor(2, 0, indirectCallStorage);
                const addressSet = this.createAddressSet(descriptorPool, constantBufferView, modelInformationView);
                this.queuedFrames.push(new QueuedFrame(constantBufferView,
                    drawSet, cullSet, addressSet, hostCommands, readback, false));
            }
            return true;
        }

        // A queued frame's device address culling set: its constants, the models' information and
        // the commands' address; null without device addresses.
        createAddressSet(descriptorPool: NriDescriptorPool, constantBufferView: NriDescriptor,
            modelInformationView: NriDescriptor): NriDescriptorSet | null {
            const addressLayout = this.addressLayout;
            const addressView = this.addressView;
            if (!addressLayout || !addressView) {
                return null;
            }
            const addressSet = descriptorPool.allocateDescriptorSet(addressLayout, 0, 0);
            if (!addressSet) {
                return null;
            }
            addressSet.updateDescriptor(0, 0, constantBufferView);
            addressSet.updateDescriptor(1, 0, modelInformationView);
            addressSet.updateDescriptor(2, 0, addressView);
            return addressSet;
        }

        // Waits for the frame that last used this frame's command allocator (and its constants and
        // copies), then counts the instances its copy of the commands holds (the GPU culling's).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            this.frames.wait(frameIndex);
            if (this.renderMode != RenderPath.Cpu && queuedFrame.readbackValid) {
                this.countInstances(queuedFrame.readback);
            }
        }

        // The visible models in a copy of the commands.
        countInstances(readback: NriBuffer) {
            const commands: int[] = [];
            for (let i = 0; i < this.modelCount * COMMAND_INTS; i++) {
                commands.push(0);
            }
            if (readback.readInts(Ref(commands[0]), commands.length) == 0) {
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
            device.waitIdle();
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

            Nri.storeInt32(Ref(c[CONST_MODEL_COUNT]), this.modelCount);
            constantBuffer.write(queuedFrameIndex * CONST_VIEW_SIZE, Ref(c[0]), CONST_FLOATS * 4);
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
                Nri.storeInt32(Ref(this.commandWords[word]), this.commands[word]);
                if (isVisible) {
                    visible++;
                }
            }
            this.instanceCount = visible;
        }

        // The CPU culling's commands, uploaded into the commands' buffer (outside rendering).
        recordUpload(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const indirectCallBuffer = this.indirectCallBuffer;
            if (!indirectCallBuffer) {
                return;
            }
            const byteSize = this.modelCount * COMMAND_SIZE;
            queuedFrame.hostCommands.write(0, Ref(this.commandWords[0]), byteSize);
            commandBuffer.bufferBarrier(indirectCallBuffer, NriBufferState.IndirectArgument, NriBufferState.CopyDestination);
            commandBuffer.copyBuffer(indirectCallBuffer, queuedFrame.hostCommands, byteSize);
            commandBuffer.bufferBarrier(indirectCallBuffer, NriBufferState.CopyDestination, NriBufferState.IndirectArgument);
        }

        // The sample's run_gpu_cull: a thread per model, writing the commands through their binding
        // or (GpuDeviceAddress) their address (outside rendering).
        recordGpuCull(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const indirectCallBuffer = this.indirectCallBuffer;
            const cullLayout = this.cullLayout;
            const cullPipeline = this.cullPipeline;
            if (!indirectCallBuffer || !cullLayout || !cullPipeline) {
                return;
            }
            const groups = Math.floor((this.modelCount + CULL_GROUP_SIZE - 1) / CULL_GROUP_SIZE);
            commandBuffer.bufferBarrier(indirectCallBuffer, NriBufferState.IndirectArgument, NriBufferState.Storage);
            if (!this.recordAddressCull(commandBuffer, queuedFrame, groups)) {
                commandBuffer.setComputePipelineLayout(cullLayout);
                commandBuffer.setPipeline(cullPipeline);
                commandBuffer.setComputeDescriptorSet(0, queuedFrame.cullSet);
                commandBuffer.dispatch(groups, 1, 1);
            }
            commandBuffer.bufferBarrier(indirectCallBuffer, NriBufferState.Storage, NriBufferState.IndirectArgument);
        }

        // The device address culling, in GpuDeviceAddress mode with device addresses; false if not.
        recordAddressCull(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame, groups: int) {
            const addressLayout = this.addressLayout;
            const addressPipeline = this.addressPipeline;
            const addressSet = queuedFrame.addressSet;
            if (this.renderMode != RenderPath.GpuDeviceAddress || !addressLayout || !addressPipeline || !addressSet) {
                return false;
            }
            commandBuffer.setComputePipelineLayout(addressLayout);
            commandBuffer.setPipeline(addressPipeline);
            commandBuffer.setComputeDescriptorSet(0, addressSet);
            commandBuffer.dispatch(groups, 1, 1);
            return true;
        }

        // The sample's overlay counts the instances the GPU culling left: from a copy of the commands
        // the queued frame reads when its turn comes back (latencySleep).
        recordCommandsCopy(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const indirectCallBuffer = this.indirectCallBuffer;
            if (!indirectCallBuffer) {
                return;
            }
            commandBuffer.bufferBarrier(indirectCallBuffer, NriBufferState.IndirectArgument, NriBufferState.CopySource);
            commandBuffer.copyBuffer(queuedFrame.readback, indirectCallBuffer, this.modelCount * COMMAND_SIZE);
            commandBuffer.bufferBarrier(indirectCallBuffer, NriBufferState.CopySource, NriBufferState.IndirectArgument);
            queuedFrame.readbackValid = true;
        }

        // The scene: one indirect call of a draw per model, or a call per model (between
        // NriCommandBuffer.beginRenderingWithDepth and NriCommandBuffer.endRendering).
        recordDraw(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
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
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(drawLayout);
            commandBuffer.setDescriptorSet(0, queuedFrame.drawSet);
            commandBuffer.setPipeline(drawPipeline);
            commandBuffer.setIndexBuffer(indexBuffer, 0, NriIndexType.UInt32);
            commandBuffer.setVertexBuffer(0, vertexBuffer, 0, VERTEX_SIZE);
            commandBuffer.setVertexBuffer(1, modelInstanceBuffer, 0, MODEL_INFORMATION_SIZE);
            if (this.enableMdi && this.multiDraw) {
                commandBuffer.drawIndexedIndirect(indirectCallBuffer, 0, this.modelCount, COMMAND_SIZE, null, 0);
            } else {
                for (let j = 0; j < this.modelCount; j++) {
                    commandBuffer.drawIndexedIndirect(indirectCallBuffer, j * COMMAND_SIZE, 1, COMMAND_SIZE, null, 0);
                }
            }
        }

        // The sample's overlay (its title, ApiVulkanSample's default).
        buildUI() {
            this.sample.imguiNewFrame();
            NriImgui.setNextWindowPos(10.0, 10.0);
            NriImgui.begin("Vulkan Example", 1);
            if (NriImgui.collapsingHeader("GPU Rendering", 1) != 0) {
                NriImgui.text(`Multi-Draw Indirect: ${this.multiDraw ? "Supported" : "Not supported"}`);
                NriImgui.text("drawIndirectFirstInstance: Supported");
                NriImgui.text(`Device buffer address: ${this.deviceAddress ? "Supported" : "Not supported"}`);

                NriImgui.text("");
                NriImgui.text(`Instances: ${this.instanceCount} / ${this.modelCount}`);

                this.enableMdi = NriImgui.checkbox("Enable multi-draw", this.enableMdi ? 1 : 0) != 0;
                this.freezeCull = NriImgui.checkbox("Freeze culling", this.freezeCull ? 1 : 0) != 0;
                this.renderMode = NriImgui.combo("Cull mode", this.renderMode, RENDER_MODE_NAMES);
            }
            NriImgui.end();
            this.sample.imguiRender();
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The depth buffer: D32, cleared to 1; at the stored size. False on failure.
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
            this.destroyDescriptor(this.depthAttachment);
            const depthTexture = this.depthTexture;
            if (depthTexture) {
                depthTexture.destroy();
            }
            this.depthAttachment = null;
            this.depthTexture = null;
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain and the depth buffer again at
        // its size, once the GPU is done with the old ones.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (!this.swapChain.resized()) {
                return;
            }
            this.swapChain.recreate();
            this.sizeToSwapChain();
            this.destroyDepth();
            this.createDepth(device);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            if (this.renderMode == RenderPath.GpuDeviceAddress && !this.deviceAddress) {
                this.renderMode = RenderPath.Gpu;
            }
            const mouseFree = !this.imgui || NriImgui.wantsMouse() == 0;
            this.camera.animate(this.sample, this.test ? Math.fround(1.0 / 60.0) : this.sample.getFrameTime(), mouseFree);
            this.writeConstants(queuedFrameIndex);
            if (!this.freezeCull && this.renderMode == RenderPath.Cpu) {
                this.cpuCull();
            }

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            const depthAttachment = this.depthAttachment;
            const descriptorPool = this.descriptorPool;
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: the culling (the CPU's commands uploaded, or the GPU's), the copy of the
                // commands, then cleared, the scene, the overlay over it.
                commandBuffer.begin();
                if (this.imgui) {
                    this.sample.copyImguiData(commandBuffer);
                }
                if (descriptorPool) {
                    commandBuffer.setDescriptorPool(descriptorPool);
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
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    commandBuffer.beginRenderingWithDepth(this.swapChain.colorAttachment(index), depthAttachment);
                    commandBuffer.clearColor(CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
                    commandBuffer.clearDepth(1.0);
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
                    queuedFrame.hostCommands.destroy();
                    queuedFrame.readback.destroy();
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                for (const view of this.textureViews) {
                    view.destroy();
                }
                for (const texture of this.textures) {
                    texture.destroy();
                }
                this.destroyDescriptor(this.sampler);
                this.destroyDepth();
                this.destroyDescriptor(this.modelInformationView);
                this.destroyDescriptor(this.indirectCallStorage);
                this.destroyDescriptor(this.addressView);
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
        const mdi = new MultiDrawIndirect(sample);
        // -nomdi: a draw call per model; -freeze: culling frozen; -mode <0..2>: the cull mode (CPU,
        // GPU, GPU device address); -noUI: no overlay.
        sample.addExampleOption("-nomdi");
        sample.addExampleOption("-freeze");
        sample.addExampleOptionWithValues("-mode", 1);
        sample.addExampleOption("-noUI");
        sample.useImgui();
        sample.useResizableWindow();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-nomdi") {
                mdi.enableMdi = false;
            } else if (arg == "-freeze") {
                mdi.freezeCull = true;
            } else if (arg == "-mode" && i + 1 < argc) {
                i++;
                mdi.renderMode = Math.min(Math.max(parseInt(Nri.getArg(argc, argv, i)), RenderPath.Cpu), RenderPath.GpuDeviceAddress);
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

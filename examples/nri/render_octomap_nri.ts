/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { multiply, rotation, translation, scale, radians, samplePerspective } from "../../core/matrix";
import { OctomapReader, hsvToRgb, sortDescending } from "../../core/octomap_common";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriFile, NriGltfModel, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace RenderOctomapNri {
    // render_octomap, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (render_octomap.hlsl's), octomap, glTF map (read as Donut's
    // loadGltfModel reads it) and Gaussian splats, through the NRI calls core/nri/nri_interop.d.ts
    // binds, with NRIFramework's ImGui for the sample's overlay. This example creates everything it
    // runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Octomap Viewer";

    // The sample's map (Vulkan-Samples' assets, copied at build time: see VULKAN_SAMPLES_ASSETS_DIR
    // in CMakeLists.txt): an octomap binary tree file, the same scene as a glTF mesh with vertex
    // colors, and as Gaussian splats in glTF files of a grid cell each (KHR_gaussian_splatting).
    const MEDIA = "media/render_octomap/";
    const OCTOMAP_PATH = "media/render_octomap/octMap.bin";
    const GLTF_PATH = "media/render_octomap/savedMap_v1.2.0.gltf";
    // The sample takes the directory's *_cell_*.gltf files, sorted.
    const SPLAT_CELLS = [
        "savedMap_v1.2.0_cell_-1_-1_-1.gltf",
        "savedMap_v1.2.0_cell_-1_-1_0.gltf",
        "savedMap_v1.2.0_cell_-1_0_-1.gltf",
        "savedMap_v1.2.0_cell_-1_0_0.gltf",
        "savedMap_v1.2.0_cell_0_-1_-1.gltf",
        "savedMap_v1.2.0_cell_0_-1_0.gltf",
        "savedMap_v1.2.0_cell_0_0_-1.gltf",
        "savedMap_v1.2.0_cell_0_0_0.gltf",
    ];

    // The views.
    enum ViewKind {
        Octomap = 0,
        Gltf = 1,
        Splats = 2
    }

    // struct InstanceData { float pos[3]; float col[4]; float scale; }.
    const INSTANCE_FLOATS = 8;
    // struct SplatInstance { float pos[3], rot[4], scale[3], opacity, color[3], _pad; }, without the
    // padding (the sample's vertex binding stride is sizeof(SplatInstance), 60 bytes).
    const SPLAT_FLOATS = 15;
    // struct UBO { float4x4 projection, camera; }, as f32 offsets; a queued frame's in a 256-byte
    // slice of the constant buffer (D3D12 constant buffer views' alignment).
    const CONST_PROJECTION = 0;
    const CONST_CAMERA = 16;
    const CONST_FLOATS = 32;
    const CONST_STRIDE = 256;
    // The glTF view's push constants (b1: root constants): float4x4 model; float4 color.
    const PUSH_FLOATS = 20;

    // The sample's camera: first person, at (0, 0, -1), 60 degrees vertically, depth from 0.1 to
    // 256; WASD move it a unit per second, numpad 4/6/8/2 turn it 60 degrees per second.
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 0.1;
    const Z_FAR = 256.0;
    const TRANSLATION_SPEED = 1.0;
    const LOOK_SPEED = 60.0;
    // ApiVulkanSample's mouse controls: degrees per pixel dragged with the left button, zoom per
    // pixel with the right one, panning per pixel with the middle one.
    const ROTATION_SPEED = 1.0;
    const ZOOM_SPEED = 0.005;
    const PAN_SPEED = 0.01;

    // GLFW's key codes: the camera's keys.
    const KEY_W = 87;
    const KEY_A = 65;
    const KEY_S = 83;
    const KEY_D = 68;
    const KEY_KP_2 = 322;
    const KEY_KP_4 = 324;
    const KEY_KP_6 = 326;
    const KEY_KP_8 = 328;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into: its command buffer, its descriptor set (its slice of the
    // UBO) and, once the splats are shown, the buffer of its splats in back to front order.
    class QueuedFrame {
        splatBuffer: NriBuffer | null = null;

        constructor(public commandBuffer: NriCommandBuffer,
            public descriptorSet: NriDescriptorSet | null, public uboView: NriDescriptor | null) {
        }
    }

    // -test: checks the last frame, read back, as the Donut example does: the top left corner is
    // black; the octomap's voxels, colored by height, cover about 56% of the frame, magenta in the
    // middle.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        if ((pixels[0] & 0xFFFFFF) != 0) {
            return "the top left corner isn't black";
        }
        const middle = pixels[Math.floor(height / 2) * width + Math.floor(width / 2)] & 0xFFFFFF;
        if ((middle & 0xFF) < 150 || ((middle >> 16) & 0xFF) < 200 || ((middle >> 8) & 0xFF) > 60) {
            return "the middle isn't magenta";
        }
        let voxels = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            const high = Math.max(r, Math.max(g, b));
            const low = Math.min(r, Math.min(g, b));
            if (high - low >= 61) {
                voxels++;
            }
        }
        const total = width * height;
        const percent = 100.0 * voxels / total;
        console.log(`Voxels: ${percent}% (${voxels} of ${total} pixels)`);
        if (percent < 45.0 || percent > 68.0) {
            return `Voxels: ${percent}% of the pixels, not 45% to 68%`;
        }
        return "";
    }

    // Port of Vulkan-Samples' render_octomap (as examples/render_octomap.ts ports it) to NRI: a map
    // of a building, as an ARKit SLAM octomap (an octree of occupied voxels, read from its compact
    // binary file and drawn as instanced cubes colored by height), as a glTF mesh with vertex
    // colors, and as Gaussian splats (glTF files with KHR_gaussian_splatting attributes, sorted back
    // to front every frame and drawn as camera-facing quads with premultiplied alpha). A
    // first-person camera moves with WASD and turns with the numpad (or the mouse); the overlay's
    // buttons pick the view. Drawn straight into the sRGB swap chain view (the Donut example draws
    // into an sRGB color buffer and blits it into its back buffer), with a D32 depth buffer.
    class RenderOctomap {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private layout: NriPipelineLayout | null = null;
        private octomapPipeline: NriPipeline | null = null;
        private gltfPipeline: NriPipeline | null = null;
        private splatPipeline: NriPipeline | null = null;
        private uniformBuffer: NriBuffer | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private depthTexture: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;

        // The view shown, as the overlay picks it (-view <0..2> at start).
        viewState: int = ViewKind.Octomap;

        // The sample's camera: rotation (degrees about x, y, z) and position; the mouse as it last
        // saw it.
        private cameraRotation: number[] = [0.0, 0.0, 0.0];
        private cameraPosition: number[] = [0.0, 0.0, -1.0];
        private buttons: boolean[] = [false, false, false];
        private mouseX: number = 0.0;
        private mouseY: number = 0.0;

        // Octomap: the cube and an instance per occupied voxel.
        private cubeVertices: NriBuffer | null = null;
        private cubeIndices: NriBuffer | null = null;
        private cubeIndexCount: int = 0;
        private instanceBuffer: NriBuffer | null = null;
        private instanceCount: int = 0;

        // glTF: loaded when first shown.
        private gltfLoaded: boolean = false;
        private gltfPositions: NriBuffer | null = null;
        private gltfColors: NriBuffer | null = null;
        private gltfIndices: NriBuffer | null = null;
        private gltfDrawIndexCount: int[] = [];
        private gltfDrawStartIndex: int[] = [];
        private gltfDrawBaseVertex: int[] = [];
        private gltfDrawConstants: f32[] = [];

        // Splats: loaded when first shown; their data, the back-to-front order, and the data in that
        // order (written into the queued frame's buffer every frame).
        private splatsLoaded: boolean = false;
        private splatData: f32[] = [];
        private splatOrder: int[] = [];
        private splatScratch: int[] = [];
        private splatDistance: number[] = [];
        private splatSorted: f32[] = [];
        private splatQuadIndices: NriBuffer | null = null;
        private splatCount: int = 0;

        // -noUI: no overlay.
        noUI: boolean = false;

        // The UBO contents and the glTF draw's root constants.
        private constants: f32[] = [];
        private pushConstants: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.constants.push(0.0);
            }
            for (let i = 0; i < PUSH_FLOATS; i++) {
                this.pushConstants.push(0.0);
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

            // Swap chain: rendered through sRGB views, as the sample's sRGB color buffer.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;

            // The depth buffer, for the window's size.
            if (!this.createDepth(device)) {
                return 0;
            }

            // The octomap: a cube, and an instance per occupied voxel; the splats' quad.
            const reader = new OctomapReader();
            const file = NriFile.load(OCTOMAP_PATH);
            if (!file) {
                console.log("Cannot read the octomap: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            const size = file.getSize();
            if (reader.resize(size)) {
                file.copyBytes(0, size, Ref(reader.bytes[0]));
            }
            file.destroy();
            const read = reader.parse();
            if (!read) {
                console.log("Cannot read the octomap: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            this.createCube(device);
            this.buildCubes(device, reader);
            const quad: int[] = [0, 1, 2, 3];
            this.splatQuadIndices = device.createUploadedBufferFromInts(this.queue, Ref(quad[0]), 16, NriBufferUsage.IndexBuffer);
            if (!this.cubeVertices || !this.cubeIndices || !this.splatQuadIndices) {
                console.log("Cannot create the octomap's buffers");
                return 0;
            }

            // The layout: the UBO (b0); the glTF view's push constants (b1: root constants), both
            // shaders' (the octomap's and the splats' pipelines don't use them).
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            layoutDesc.addRootConstants(1, PUSH_FLOATS * 4, NriStage.VertexPixel);
            const layout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
            this.layout = layout;
            if (!layout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The sample's pipelines (render_octomap.hlsl's shaders, as compiled for the Donut
            // example): depth from 0 to 1 (less or equal passes), counter-clockwise front faces,
            // clipped at the near plane as Vulkan does (the camera walks through the map's walls);
            // the splats unculled, without depth writes, blended with premultiplied alpha.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : (graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv");
            const shaders = `shaders/render_octomap/${folder}/render_octomap`;
            this.octomapPipeline = this.createPipeline(device, layout, shaders, ViewKind.Octomap);
            this.gltfPipeline = this.createPipeline(device, layout, shaders, ViewKind.Gltf);
            this.splatPipeline = this.createPipeline(device, layout, shaders, ViewKind.Splats);
            if (!this.octomapPipeline || !this.gltfPipeline || !this.splatPipeline) {
                console.log("Cannot load the render octomap shaders");
                return 0;
            }

            // The UBO, a queued frame's each; a queued frame's descriptor set.
            const uniformBuffer = device.createHostBuffer(queuedFrameNum * CONST_STRIDE, NriBufferUsage.ConstantBuffer);
            this.uniformBuffer = uniformBuffer;
            const descriptorPool = device.createDescriptorPool(queuedFrameNum, 0, queuedFrameNum, 0, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!uniformBuffer || !descriptorPool) {
                console.log("Cannot create the descriptors");
                return 0;
            }
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const uboView = uniformBuffer.createConstantView(i * CONST_STRIDE, CONST_STRIDE);
                const descriptorSet = descriptorPool.allocateDescriptorSet(layout, 0, 0);
                this.queuedFrames.push(new QueuedFrame(new NriCommandBuffer(this.frames.commandBuffer(i).handle), descriptorSet, uboView));
                if (!uboView || !descriptorSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                descriptorSet.updateDescriptor(0, 0, uboView);
            }

            // The view at start (its data loaded now).
            this.setViewState(this.viewState);

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

        // A view's pipeline: the octomap's cube positions (stream 0) and voxels (stream 1, per
        // instance), the glTF map's positions (stream 0) and colors (stream 1), or the splats (stream
        // 0, per instance: a triangle strip each).
        createPipeline(device: NriDevice, layout: NriPipelineLayout, shaders: string, view: int) {
            const vs = view == ViewKind.Octomap ? "render_vs" : (view == ViewKind.Gltf ? "gltf_vs" : "splat_vs");
            const ps = view == ViewKind.Splats ? "splat_ps" : "color_ps";
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_${vs}.bin`, vs) != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_${ps}.bin`, ps) != 0;
            }
            if (view == ViewKind.Octomap) {
                desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
                desc.addVertexAttributeFromStream("INSTANCE_POSITION", NriFormat.RGB32_SFLOAT, 0, 1);
                desc.addVertexAttributeFromStream("INSTANCE_COLOR", NriFormat.RGBA32_SFLOAT, 12, 1);
                desc.addVertexAttributeFromStream("INSTANCE_SCALE", NriFormat.R32_SFLOAT, 28, 1);
                desc.setInstanceStream(1);
            } else if (view == ViewKind.Gltf) {
                desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
                desc.addVertexAttributeFromStream("COLOR", NriFormat.RGBA32_SFLOAT, 0, 1);
            } else {
                desc.addVertexAttribute("SPLAT_POSITION", NriFormat.RGB32_SFLOAT, 0);
                desc.addVertexAttribute("SPLAT_ROTATION", NriFormat.RGBA32_SFLOAT, 12);
                desc.addVertexAttribute("SPLAT_SCALE", NriFormat.RGB32_SFLOAT, 28);
                desc.addVertexAttribute("SPLAT_OPACITY", NriFormat.R32_SFLOAT, 40);
                desc.addVertexAttribute("SPLAT_COLOR", NriFormat.RGB32_SFLOAT, 44);
                desc.setInstanceStream(0);
                desc.setTopology(NriTopology.TriangleStrip);
            }
            desc.setCullMode(view == ViewKind.Splats ? NriCullMode.None : NriCullMode.Back);
            desc.setFrontCounterClockwise(1);
            desc.setDepthClip(1);
            desc.setColor(this.viewFormat, NriColorWrite.RGBA);
            if (view == ViewKind.Splats) {
                // Donut's Premultiplied: color One + InvSrcAlpha, alpha One + InvSrcAlpha.
                desc.setBlend(NriBlendFactor.One, NriBlendFactor.OneMinusSrcAlpha, NriBlendOp.Add,
                    NriBlendFactor.One, NriBlendFactor.OneMinusSrcAlpha, NriBlendOp.Add);
            }
            desc.setDepth(NriFormat.D32_SFLOAT, NriCompareOp.LessEqual, view == ViewKind.Splats ? 0 : 1, 0);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        // The sample's generate_master_cube: a unit cube, counter-clockwise outward faces.
        createCube(device: NriDevice) {
            const vertices: f32[] = [
                0.5, 0.5, 0.5,
                0.5, 0.5, -0.5,
                0.5, -0.5, 0.5,
                0.5, -0.5, -0.5,
                -0.5, 0.5, 0.5,
                -0.5, 0.5, -0.5,
                -0.5, -0.5, 0.5,
                -0.5, -0.5, -0.5,
            ];
            const indices: int[] = [
                // Right face (+X) - looking from +X toward origin
                0, 2, 3, 3, 1, 0,
                // Left face (-X) - looking from -X toward origin
                4, 5, 7, 7, 6, 4,
                // Top face (+Y) - looking from +Y toward origin
                0, 1, 5, 5, 4, 0,
                // Bottom face (-Y) - looking from -Y toward origin
                2, 6, 7, 7, 3, 2,
                // Back face (+Z) - looking from +Z toward origin
                0, 4, 6, 6, 2, 0,
                // Front face (-Z) - looking from -Z toward origin
                1, 3, 7, 7, 5, 1,
            ];
            this.cubeIndexCount = indices.length;
            this.cubeVertices = device.createUploadedBuffer(this.queue, Ref(vertices[0]), vertices.length * 4, NriBufferUsage.VertexBuffer);
            this.cubeIndices = device.createUploadedBufferFromInts(this.queue, Ref(indices[0]), indices.length * 4,
                NriBufferUsage.IndexBuffer);
        }

        // The sample's build_cubes: an instance per occupied leaf, at its center (y negated), its
        // size, colored by height (hue from red, high, to 80% of the circle, low) between the
        // lowest and highest corners of all leaves.
        buildCubes(device: NriDevice, reader: OctomapReader) {
            const leaves = reader.leaves;
            const leafCount = reader.occupied.length;
            let minZ = 1e300;
            let maxZ = -1e300;
            for (let i = 0; i < leafCount; i++) {
                const halfSize = leaves[i * 4 + 3] / 2.0;
                minZ = Math.min(minZ, leaves[i * 4 + 2] - halfSize);
                maxZ = Math.max(maxZ, leaves[i * 4 + 2] - halfSize + leaves[i * 4 + 3]);
            }
            const zRange = maxZ - minZ;

            const instances: f32[] = [];
            const rgb: number[] = [0.0, 0.0, 0.0];
            for (let i = 0; i < leafCount; i++) {
                if (!reader.occupied[i]) {
                    continue;
                }
                const z = leaves[i * 4 + 2];
                instances.push(leaves[i * 4]);
                instances.push(-leaves[i * 4 + 1]);
                instances.push(z);
                let h = 0.5;
                if (zRange > 0.0) {
                    h = (1.0 - Math.min(Math.max((z - minZ) / zRange, 0.0), 1.0)) * 0.8;
                }
                hsvToRgb(h, 1.0, 1.0, rgb);
                instances.push(rgb[0]);
                instances.push(rgb[1]);
                instances.push(rgb[2]);
                instances.push(1.0);
                instances.push(leaves[i * 4 + 3]);
            }
            this.instanceCount = Math.floor(instances.length / INSTANCE_FLOATS);
            if (this.instanceCount > 0) {
                this.instanceBuffer = device.createUploadedBuffer(this.queue, Ref(instances[0]), instances.length * 4,
                    NriBufferUsage.VertexBuffer);
            }
        }

        // The sample's load_gltf_scene: the meshes' primitives (POSITION and COLOR_0) in shared
        // buffers, drawn per node (each node instancing a mesh, its primitives), the node's world
        // transform mirrored in y (the octomap's convention) and its material's color.
        loadGltf(device: NriDevice) {
            this.gltfLoaded = true;
            const model = NriGltfModel.load(GLTF_PATH);
            if (!model) {
                console.log("Cannot load the glTF map: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return;
            }
            const primitiveCount = model.getPrimitiveCount();
            const positions: f32[] = [];
            const colors: f32[] = [];
            const indices: int[] = [];
            const primitiveFirstIndex: int[] = [];
            const primitiveIndexCount: int[] = [];
            const primitiveBaseVertex: int[] = [];
            const primitiveColor: f32[] = [];
            const color: f32[] = [1.0, 1.0, 1.0, 1.0];
            for (let p = 0; p < primitiveCount; p++) {
                const vertexCount = model.getAttributeCount(p, "POSITION");
                const indexCount = model.getIndexCount(p);
                if (vertexCount == 0 || indexCount == 0 || model.getAttributeComponents(p, "COLOR_0") != 4) {
                    primitiveFirstIndex.push(0);
                    primitiveIndexCount.push(0);
                    primitiveBaseVertex.push(0);
                    for (let i = 0; i < 4; i++) {
                        primitiveColor.push(1.0);
                    }
                    continue;
                }
                const firstVertex = Math.floor(positions.length / 3);
                for (let i = 0; i < vertexCount * 3; i++) {
                    positions.push(0.0);
                }
                for (let i = 0; i < vertexCount * 4; i++) {
                    colors.push(0.0);
                }
                model.copyAttribute(p, "POSITION", Ref(positions[firstVertex * 3]));
                model.copyAttribute(p, "COLOR_0", Ref(colors[firstVertex * 4]));
                const firstIndex = indices.length;
                for (let i = 0; i < indexCount; i++) {
                    indices.push(0);
                }
                model.copyIndices(p, Ref(indices[firstIndex]));
                primitiveFirstIndex.push(firstIndex);
                primitiveIndexCount.push(indexCount);
                primitiveBaseVertex.push(firstVertex);
                // Try to get color from material, otherwise use white
                model.copyBaseColorFactor(p, Ref(color[0]));
                for (let i = 0; i < 4; i++) {
                    primitiveColor.push(color[i]);
                }
            }

            const flipY = scale(1.0, -1.0, 1.0);
            const transform: f32[] = [];
            for (let i = 0; i < 16; i++) {
                transform.push(0.0);
            }
            const nodeCount = model.getNodeCount();
            for (let node = 0; node < nodeCount && indices.length > 0; node++) {
                const mesh = model.getNodeMesh(node);
                model.copyNodeTransform(node, Ref(transform[0]));
                const world: number[] = [];
                for (let i = 0; i < 16; i++) {
                    world.push(transform[i]);
                }
                const modelMatrix = multiply(flipY, world);
                for (let p = 0; p < primitiveCount; p++) {
                    if (model.getPrimitiveMesh(p) != mesh || primitiveIndexCount[p] == 0) {
                        continue;
                    }
                    this.gltfDrawIndexCount.push(primitiveIndexCount[p]);
                    this.gltfDrawStartIndex.push(primitiveFirstIndex[p]);
                    this.gltfDrawBaseVertex.push(primitiveBaseVertex[p]);
                    for (let i = 0; i < 16; i++) {
                        this.gltfDrawConstants.push(modelMatrix[i]);
                    }
                    for (let i = 0; i < 4; i++) {
                        this.gltfDrawConstants.push(primitiveColor[p * 4 + i]);
                    }
                }
            }
            model.destroy();
            if (indices.length == 0) {
                return;
            }

            this.gltfPositions = device.createUploadedBuffer(this.queue, Ref(positions[0]), positions.length * 4, NriBufferUsage.VertexBuffer);
            this.gltfColors = device.createUploadedBuffer(this.queue, Ref(colors[0]), colors.length * 4, NriBufferUsage.VertexBuffer);
            this.gltfIndices = device.createUploadedBufferFromInts(this.queue, Ref(indices[0]), indices.length * 4, NriBufferUsage.IndexBuffer);
        }

        // One accessor of a splat cell, count elements of `components` floats, into the splats'
        // data at `offset` of each splat (the splats from `first` on).
        copySplatAttribute(model: NriGltfModel, name: string, components: int, offset: int, first: int, count: int) {
            if (model.getAttributeCount(0, name) != count || model.getAttributeComponents(0, name) < components) {
                return false;
            }
            const stride = model.getAttributeComponents(0, name);
            const values: f32[] = [];
            for (let i = 0; i < count * stride; i++) {
                values.push(0.0);
            }
            model.copyAttribute(0, name, Ref(values[0]));
            for (let i = 0; i < count; i++) {
                for (let k = 0; k < components; k++) {
                    this.splatData[(first + i) * SPLAT_FLOATS + offset + k] = values[i * stride + k];
                }
            }
            return true;
        }

        // The sample's load_gaussian_splats_scene: every cell's splats (POSITION,
        // KHR_gaussian_splatting:ROTATION, SCALE, OPACITY, and COLOR_0 or else the SH degree 0
        // coefficients), appended in the cells' order; a buffer per queued frame for them sorted.
        loadSplats(device: NriDevice) {
            this.splatsLoaded = true;
            for (const splatCell of SPLAT_CELLS) {
                const model = NriGltfModel.load(MEDIA + splatCell);
                if (!this.appendSplats(model, splatCell)) {
                    console.log(`Cannot load the splats of ${splatCell}`);
                }
            }
            this.splatCount = Math.floor(this.splatData.length / SPLAT_FLOATS);
            if (this.splatCount == 0) {
                return;
            }
            for (let i = 0; i < this.splatCount; i++) {
                this.splatOrder.push(i);
                this.splatScratch.push(0);
                this.splatDistance.push(0.0);
            }
            for (let i = 0; i < this.splatData.length; i++) {
                this.splatSorted.push(0.0);
            }
            for (const queuedFrame of this.queuedFrames) {
                queuedFrame.splatBuffer = device.createHostBuffer(this.splatData.length * 4, NriBufferUsage.VertexBuffer);
            }
        }

        // A cell's splats appended (false if it can't be read; the model destroyed after).
        appendSplats(model: NriGltfModel | null, splatCell: string) {
            if (!model) {
                return false;
            }
            if (model.getPrimitiveCount() == 0) {
                model.destroy();
                return false;
            }
            const count = model.getAttributeCount(0, "POSITION");
            const first = Math.floor(this.splatData.length / SPLAT_FLOATS);
            for (let i = 0; i < count * SPLAT_FLOATS; i++) {
                this.splatData.push(0.0);
            }
            let ok = this.copySplatAttribute(model, "POSITION", 3, 0, first, count)
                && this.copySplatAttribute(model, "KHR_gaussian_splatting:ROTATION", 4, 3, first, count)
                && this.copySplatAttribute(model, "KHR_gaussian_splatting:SCALE", 3, 7, first, count)
                && this.copySplatAttribute(model, "KHR_gaussian_splatting:OPACITY", 1, 10, first, count);
            if (ok) {
                ok = this.copySplatAttribute(model, "COLOR_0", 3, 11, first, count)
                    || this.copySplatAttribute(model, "KHR_gaussian_splatting:SH_DEGREE_0_COEF_0", 3, 11, first, count);
            }
            if (!ok) {
                console.log(`${splatCell} lacks the KHR_gaussian_splatting attributes`);
                while (this.splatData.length > first * SPLAT_FLOATS) {
                    this.splatData.pop();
                }
            }
            model.destroy();
            return true;
        }

        // The sample's on_view_state_changed: the glTF scene and the splats load when first shown.
        setViewState(viewState: int) {
            this.viewState = viewState;
            const device = this.device;
            if (!device) {
                return;
            }
            if (viewState == ViewKind.Gltf && !this.gltfLoaded) {
                this.loadGltf(device);
            } else if (viewState == ViewKind.Splats && !this.splatsLoaded) {
                this.loadSplats(device);
            }
        }

        // Waits for the frame that last used this frame's command allocator (and its UBO slice and
        // splat buffer).
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // ApiVulkanSample's mouse handling, unless the overlay has the mouse: dragging with the left
        // button rotates the camera, with the right one zooms, with the middle one pans.
        handleMouse() {
            const overlay = this.imgui && NriImgui.wantsMouse() != 0;
            for (let button = 0; button < 3; button++) {
                const pressed = this.sample.isButtonPressed(button) != 0;
                if (!pressed || !overlay) {
                    this.buttons[button] = pressed;
                }
            }
            const x = this.sample.getMouseX();
            const y = this.sample.getMouseY();
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

        // The framework's first-person camera update (WASD along the view direction and its
        // right), then the sample's numpad look; the frame's time (Donut's test mode: a float's
        // 1/60 second).
        animate() {
            const elapsedSeconds = this.test ? Math.fround(1.0 / 60.0) : this.sample.getFrameTime();
            const keyUp = this.sample.isKeyPressed(KEY_W) != 0;
            const keyDown = this.sample.isKeyPressed(KEY_S) != 0;
            const keyLeft = this.sample.isKeyPressed(KEY_A) != 0;
            const keyRight = this.sample.isKeyPressed(KEY_D) != 0;
            const r = this.cameraRotation;
            const p = this.cameraPosition;
            if (keyUp || keyDown || keyLeft || keyRight) {
                let fx = -Math.cos(radians(r[0])) * Math.sin(radians(r[1]));
                let fy = Math.sin(radians(r[0]));
                let fz = Math.cos(radians(r[0])) * Math.cos(radians(r[1]));
                const length = Math.sqrt(fx * fx + fy * fy + fz * fz);
                fx /= length;
                fy /= length;
                fz /= length;
                // normalize(cross(front, (0, 1, 0))).
                const rightLength = Math.sqrt(fz * fz + fx * fx);
                const rx = -fz / rightLength;
                const rz = fx / rightLength;
                const moveSpeed = elapsedSeconds * TRANSLATION_SPEED;
                if (keyUp) {
                    p[0] += fx * moveSpeed;
                    p[1] += fy * moveSpeed;
                    p[2] += fz * moveSpeed;
                }
                if (keyDown) {
                    p[0] -= fx * moveSpeed;
                    p[1] -= fy * moveSpeed;
                    p[2] -= fz * moveSpeed;
                }
                if (keyLeft) {
                    p[0] -= rx * moveSpeed;
                    p[2] -= rz * moveSpeed;
                }
                if (keyRight) {
                    p[0] += rx * moveSpeed;
                    p[2] += rz * moveSpeed;
                }
            }

            // Apply numpad look: KP_4/6 = yaw left/right, KP_8/2 = pitch up/down
            const lookSpeed = LOOK_SPEED * elapsedSeconds;
            if (this.sample.isKeyPressed(KEY_KP_8) != 0) {
                r[0] -= lookSpeed;
            }
            if (this.sample.isKeyPressed(KEY_KP_2) != 0) {
                r[0] += lookSpeed;
            }
            if (this.sample.isKeyPressed(KEY_KP_4) != 0) {
                r[1] += lookSpeed;
            }
            if (this.sample.isKeyPressed(KEY_KP_6) != 0) {
                r[1] -= lookSpeed;
            }
        }

        // The sample's overlay: the view buttons (its title, ApiVulkanSample's default).
        buildUI() {
            this.sample.imguiNewFrame();
            NriImgui.setNextWindowPos(10.0, 10.0);
            NriImgui.begin("Vulkan Example", 1);
            if (NriImgui.button("OCTOMAP") != 0) {
                this.setViewState(ViewKind.Octomap);
            }
            if (NriImgui.button("GLTF MAP") != 0) {
                this.setViewState(ViewKind.Gltf);
            }
            if (NriImgui.button("SPLATS") != 0) {
                this.setViewState(ViewKind.Splats);
            }
            NriImgui.end();
            this.sample.imguiRender();
        }

        // The sample's update_ubo: a first-person camera, rotation * translation, into this frame's
        // slice.
        updateConstants(uniformBuffer: NriBuffer, offset: int) {
            const c = this.constants;
            const projection = samplePerspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR);
            const r = this.cameraRotation;
            let rotationMatrix = multiply(rotation(radians(r[0]), 1.0, 0.0, 0.0), rotation(radians(r[1]), 0.0, 1.0, 0.0));
            rotationMatrix = multiply(rotationMatrix, rotation(radians(r[2]), 0.0, 0.0, 1.0));
            const p = this.cameraPosition;
            const view = multiply(rotationMatrix, translation(p[0], p[1], p[2]));
            for (let i = 0; i < 16; i++) {
                c[CONST_PROJECTION + i] = projection[i];
                c[CONST_CAMERA + i] = view[i];
            }
            uniformBuffer.write(offset, Ref(c[0]), CONST_FLOATS * 4);
        }

        // Sort splats back-to-front for correct alpha compositing, from the camera's position
        // (-R^T * t of the view, the position negated for this camera), and write them in that
        // order.
        sortSplatsInto(splatBuffer: NriBuffer | null) {
            if (!splatBuffer) {
                return;
            }
            const p = this.cameraPosition;
            const cx = -p[0];
            const cy = -p[1];
            const cz = -p[2];
            const data = this.splatData;
            for (let i = 0; i < this.splatCount; i++) {
                const dx = data[i * SPLAT_FLOATS] - cx;
                const dy = data[i * SPLAT_FLOATS + 1] - cy;
                const dz = data[i * SPLAT_FLOATS + 2] - cz;
                this.splatDistance[i] = dx * dx + dy * dy + dz * dz;
            }
            sortDescending(this.splatOrder, this.splatDistance, this.splatScratch);
            const sorted = this.splatSorted;
            for (let i = 0; i < this.splatCount; i++) {
                const src = this.splatOrder[i] * SPLAT_FLOATS;
                const dst = i * SPLAT_FLOATS;
                for (let k = 0; k < SPLAT_FLOATS; k++) {
                    sorted[dst + k] = data[src + k];
                }
            }
            splatBuffer.write(0, Ref(sorted[0]), this.splatCount * SPLAT_FLOATS * 4);
        }

        // The octomap's voxels: the cube instanced (between NriCommandBuffer.beginRenderingWithDepth and
        // NriCommandBuffer.endRendering).
        drawOctomap(commandBuffer: NriCommandBuffer) {
            const pipeline = this.octomapPipeline;
            const cubeVertices = this.cubeVertices;
            const cubeIndices = this.cubeIndices;
            const instanceBuffer = this.instanceBuffer;
            if (!pipeline || !cubeVertices || !cubeIndices || !instanceBuffer) {
                return;
            }
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setVertexBuffer(0, cubeVertices, 0, 12);
            commandBuffer.setVertexBuffer(1, instanceBuffer, 0, INSTANCE_FLOATS * 4);
            commandBuffer.setIndexBuffer(cubeIndices, 0, NriIndexType.UInt32);
            commandBuffer.drawIndexed(this.cubeIndexCount, this.instanceCount, 0, 0, 0);
        }

        // The glTF map: a draw per node's primitive, its model matrix and color as root constants.
        drawGltf(commandBuffer: NriCommandBuffer) {
            const pipeline = this.gltfPipeline;
            const gltfPositions = this.gltfPositions;
            const gltfColors = this.gltfColors;
            const gltfIndices = this.gltfIndices;
            if (!pipeline || !gltfPositions || !gltfColors || !gltfIndices) {
                return;
            }
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setVertexBuffer(0, gltfPositions, 0, 12);
            commandBuffer.setVertexBuffer(1, gltfColors, 0, 16);
            commandBuffer.setIndexBuffer(gltfIndices, 0, NriIndexType.UInt32);
            for (let d = 0; d < this.gltfDrawIndexCount.length; d++) {
                for (let i = 0; i < PUSH_FLOATS; i++) {
                    this.pushConstants[i] = this.gltfDrawConstants[d * PUSH_FLOATS + i];
                }
                commandBuffer.setRootConstants(0, Ref(this.pushConstants[0]), PUSH_FLOATS * 4);
                commandBuffer.drawIndexed(this.gltfDrawIndexCount[d], 1, this.gltfDrawStartIndex[d], this.gltfDrawBaseVertex[d], 0);
            }
        }

        // The splats, back to front: a quad (triangle strip) each, from the queued frame's buffer.
        drawSplats(commandBuffer: NriCommandBuffer, splatBuffer: NriBuffer | null) {
            const pipeline = this.splatPipeline;
            const splatQuadIndices = this.splatQuadIndices;
            if (!pipeline || !splatQuadIndices || !splatBuffer) {
                return;
            }
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setVertexBuffer(0, splatBuffer, 0, SPLAT_FLOATS * 4);
            commandBuffer.setIndexBuffer(splatQuadIndices, 0, NriIndexType.UInt32);
            commandBuffer.drawIndexed(4, this.splatCount, 0, 0, 0);
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The depth buffer at the swap chain's size.
        createDepth(device: NriDevice): boolean {
            const depthTexture = device.createDepthTexture(this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            if (!depthTexture) {
                console.log("Cannot create the depth buffer");
                return false;
            }
            this.depthTexture = depthTexture;
            this.depthAttachment = depthTexture.createDepthAttachmentView(NriFormat.D32_SFLOAT);
            return true;
        }

        destroyDepth() {
            this.destroyDescriptor(this.depthAttachment);
            this.depthAttachment = null;
            const depthTexture = this.depthTexture;
            if (depthTexture) {
                depthTexture.destroy();
            }
            this.depthTexture = null;
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain and the depth buffer made
        // again at its size, once the GPU is done with the old ones (the projection, viewport and
        // scissor read the size every frame).
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
            this.animate();

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                this.recordAndPresent(frameIndex, queuedFrame, queuedFrameIndex, index);
            }

            // Signaled after the present, as NRISamples do
            this.frames.signal(frameIndex);
        }

        // Records the frame into the swap chain texture, submits it and presents it.
        recordAndPresent(frameIndex: int, queuedFrame: QueuedFrame, queuedFrameIndex: int, index: int) {
            const descriptorPool = this.descriptorPool;
            const uniformBuffer = this.uniformBuffer;
            const depthAttachment = this.depthAttachment;
            const layout = this.layout;
            const descriptorSet = queuedFrame.descriptorSet;
            if (!descriptorPool || !uniformBuffer || !depthAttachment || !layout || !descriptorSet) {
                return;
            }
            const commandBuffer = queuedFrame.commandBuffer;
            this.updateConstants(uniformBuffer, queuedFrameIndex * CONST_STRIDE);
            const splatBuffer = queuedFrame.splatBuffer;
            if (this.viewState == ViewKind.Splats) {
                this.sortSplatsInto(splatBuffer);
            }

            commandBuffer.begin();
            if (this.imgui) {
                this.sample.copyImguiData(commandBuffer);
            }
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.textureBarrier(this.swapChain.texture(index), NriTextureState.Undefined, NriTextureState.ColorAttachment);

            // The view, over black (depth cleared to 1).
            commandBuffer.beginRenderingWithDepth(this.swapChain.colorAttachment(index), depthAttachment);
            commandBuffer.clearColor(0.0, 0.0, 0.0, 1.0);
            commandBuffer.clearDepth(1.0);
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(layout);
            commandBuffer.setDescriptorSet(0, descriptorSet);
            if (this.viewState == ViewKind.Octomap) {
                this.drawOctomap(commandBuffer);
            } else if (this.viewState == ViewKind.Gltf) {
                this.drawGltf(commandBuffer);
            } else {
                this.drawSplats(commandBuffer, splatBuffer);
            }
            commandBuffer.endRendering();
            // The overlay in a pass of its own: NRIFramework's ImGui pipeline has no depth attachment.
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
                    commandBuffer.textureBarrier(this.swapChain.texture(index), NriTextureState.ColorAttachment, NriTextureState.CopySource);
                    commandBuffer.readbackTextureToBuffer(readbackBuffer, this.rowPitch, this.swapChain.texture(index), this.width, this.height);
                    presentFrom = NriTextureState.CopySource;
                }
            }
            commandBuffer.textureBarrier(this.swapChain.texture(index), presentFrom, NriTextureState.Present);
            commandBuffer.end();

            // Submit and present
            this.swapChain.submit(commandBuffer, index);
            if (this.imgui) {
                this.sample.imguiEndFrame();
            }
            this.swapChain.present(index);
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
                    this.destroyDescriptor(queuedFrame.uboView);
                    this.destroyBuffer(queuedFrame.splatBuffer);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                this.destroyPipeline(this.octomapPipeline);
                this.destroyPipeline(this.gltfPipeline);
                this.destroyPipeline(this.splatPipeline);
                const layout = this.layout;
                if (layout) {
                    layout.destroy();
                }
                this.destroyDepth();
                this.destroyBuffer(this.uniformBuffer);
                this.destroyBuffer(this.cubeVertices);
                this.destroyBuffer(this.cubeIndices);
                this.destroyBuffer(this.instanceBuffer);
                this.destroyBuffer(this.gltfPositions);
                this.destroyBuffer(this.gltfColors);
                this.destroyBuffer(this.gltfIndices);
                this.destroyBuffer(this.splatQuadIndices);
                this.destroyBuffer(this.readbackBuffer);
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
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        const octomap = new RenderOctomap(sample);
        // -view <0..2>: the view at start (octomap, glTF map, splats); -noUI: no overlay.
        sample.addExampleOptionWithValues("-view", 1);
        sample.addExampleOption("-noUI");
        sample.useImgui();
        sample.useResizableWindow();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-view" && i + 1 < argc) {
                i++;
                octomap.viewState = Math.min(Math.max(parseInt(Nri.getArg(argc, argv, i)), 0), ViewKind.Splats);
            } else if (arg == "-noUI") {
                octomap.noUI = true;
            }
        }
        return octomap.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return RenderOctomapNri.main(argc, argv);
}

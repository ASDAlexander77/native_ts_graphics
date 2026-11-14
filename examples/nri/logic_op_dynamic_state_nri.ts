/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { multiply, rotation, translation, radians, samplePerspective } from "../../core/matrix";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriGltfMesh, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace LogicOpDynamicStateNri {
    // logic_op_dynamic_state, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead
    // of Donut and NVRHI: the same shaders (logic_op_dynamic_state.hlsl's, and Donut's blit shaders),
    // model (read as Donut's loadGltfMesh reads it) and cube map, through the NRI calls
    // core/nri/nri_interop.d.ts binds, with NRIFramework's ImGui for the sample's overlay. This
    // example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no logic operations.
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Logic Operations Dynamic State";

    // The sample's background model and HDR cube map (Vulkan-Samples' assets), the KTX cube map
    // converted to DDS at build time (see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const BACKGROUND_PATH = "media/logic_op_dynamic_state/cube.gltf";
    const ENVMAP_PATH = "media/logic_op_dynamic_state/uffizi_rgba16f_cube.dds";

    // NriDevice.loadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;

    // struct UBOCOMM { float4x4 projection, view; } and struct UBOBAS, as f32 offsets; a queued
    // frame's each in a 256-byte slice of the constant buffer (D3D12 constant buffer views'
    // alignment).
    const CONST_PROJECTION = 0;
    const CONST_VIEW = 16;
    const CONST_FLOATS = 32;
    const BASELINE_FLOATS = 16;
    const CONST_STRIDE = 256;
    // The push constants: float4x4 model_matrix (identity: glm's, GLM_FORCE_CTOR_INIT); float4 color
    // (at b2: root constants).
    const PUSH_FLOATS = 20;
    const PUSH_REGISTER = 2;

    // Donut's blit (CommonRenderPasses::BlitTexture) of the color buffer into the swap chain
    // texture: struct BlitConstants { float2 sourceOrigin, sourceSize, targetOrigin, targetSize;
    // float sharpenFactor; }.
    const BLIT_CONSTANT_FLOATS = 9;

    // The logic operations, in Vulkan's VkLogicOp order (NriPipelineDesc.setLogicOp's).
    const LOGIC_OP_NAMES = "CLEAR|AND|AND_REVERSE|COPY|AND_INVERTED|NO_OP|XOR|OR|NOR|EQUIVALENT|INVERT|OR_REVERSE|COPY_INVERTED|OR_INVERTED|NAND|SET";
    const LOGIC_OP_COUNT = 16;
    const LOGIC_OP_COPY = 3;

    // The sample's camera: a "look at" camera at (2, -4, -10), turned by (-15, 190, 0) degrees, 60
    // degrees vertically, reversed depth from 256 to 0.1 (glm::perspective with near and far swapped).
    const CAMERA_POSITION = [2.0, -4.0, -10.0];
    const CAMERA_ROTATION = [-15.0, 190.0, 0.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;
    // ApiVulkanSample's mouse controls: degrees per pixel dragged with the left button, zoom per
    // pixel with the right one, panning per pixel with the middle one.
    const ROTATION_SPEED = 1.0;
    const ZOOM_SPEED = 0.005;
    const PAN_SPEED = 0.01;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // A frame in flight's own data: its descriptor set (its slices of
    // the common and the lighting UBO, the cube map, the sampler) with the UBOs' views.
    class QueuedFrame {
        constructor(public descriptorSet: NriDescriptorSet | null, public commonView: NriDescriptor | null,
            public baselineView: NriDescriptor | null) {
        }
    }

    function normalize3(x: number, y: number, z: number) {
        const length = Math.sqrt(x * x + y * y + z * z);
        return [x / length, y / length, z / length];
    }

    // -test: checks the last frame, read back, as the Donut example does: the street around (75% to
    // 95% of the pixels not near black), and the dark teal cube in the middle (90% of its 20 x 20
    // pixels), drawn with the logic operation (copy by default).
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const total = width * height;
        let dark = 0;
        for (let i = 0; i < total; i++) {
            const p = pixels[i];
            if ((p & 0xFF) <= 20 && ((p >> 8) & 0xFF) <= 20 && ((p >> 16) & 0xFF) <= 20) {
                dark++;
            }
        }
        const lit = 100.0 * (total - dark) / total;
        console.log(`Lit: ${lit}% (${total - dark} of ${total} pixels)`);
        if (lit < 75.0 || lit > 95.0) {
            return `Lit: ${lit}% of the pixels, not 75% to 95%`;
        }
        let cube = 0;
        for (let y = height / 2 - 10; y < height / 2 + 10; y++) {
            for (let x = width / 2 - 10; x < width / 2 + 10; x++) {
                const p = pixels[y * width + x];
                const r = p & 0xFF;
                const g = (p >> 8) & 0xFF;
                const b = (p >> 16) & 0xFF;
                if (r >= 5 && r <= 40 && g >= 10 && g <= 45 && b >= 10 && b <= 45) {
                    cube++;
                }
            }
        }
        const cubePercent = 100.0 * cube / (20 * 20);
        console.log(`Cube in the middle: ${cubePercent}% (${cube} of 400 pixels)`);
        if (cubePercent < 90.0) {
            return `Cube in the middle: ${cubePercent}% of the pixels, not 90% to 100%`;
        }
        return "";
    }

    // Port of Vulkan-Samples' logic_op_dynamic_state (as examples/logic_op_dynamic_state.ts ports it)
    // to NRI: a lit cube in front of an HDR environment, the cube's pixels combined with what is
    // behind them by a logic operation on their bits (XOR, OR, INVERT...) instead of blending, picked
    // in the UI. The sample changes the operation as dynamic state of one pipeline; NRI has it in the
    // pipeline (as D3D), so here it is a pipeline per operation, created as the UI picks it. As in the
    // Donut example, one color texture takes the place of the sample's UNORM swapchain: the
    // background draws into it as RGBA8_UNORM, the cube too on Vulkan, as RGBA8_UINT on D3D (D3D12
    // has logic operations on UINT targets only: the cube's pixel shader, UINT_OUTPUT=1, converts its
    // color as UNORM would), and it's read as RGBA8_SRGB when blitted (Donut's blit shaders) into the
    // sRGB swap chain view, which stores the same bytes. (NRI's textures take views of other formats
    // of the same size: typeless on D3D, MUTABLE_FORMAT on Vulkan.)
    class LogicOpDynamicState {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private layout: NriPipelineLayout | null = null;
        private blitLayout: NriPipelineLayout | null = null;
        private backgroundPipeline: NriPipeline | null = null;
        private blitPipeline: NriPipeline | null = null;
        // A pipeline per logic operation, created when first drawn.
        private baselinePipelines: (NriPipeline | null)[] = [];
        private shaders: string = "";
        private background: NriGltfMesh | null = null;
        private envmap: NriTexture | null = null;
        private envmapView: NriDescriptor | null = null;
        private anisotropicWrap: NriDescriptor | null = null;
        private linearClamp: NriDescriptor | null = null;
        private cubePositions: NriBuffer | null = null;
        private cubeNormals: NriBuffer | null = null;
        private cubeIndices: NriBuffer | null = null;
        private cubeIndexCount: int = 0;
        // The color buffer, as UNORM, as the cube's logic operation takes it (UINT on D3D) and as
        // the blit reads it (sRGB); the depth buffer.
        private colorBuffer: NriTexture | null = null;
        private colorAttachment: NriDescriptor | null = null;
        private logicOpAttachment: NriDescriptor | null = null;
        private colorView: NriDescriptor | null = null;
        private depthTexture: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
        private constantBuffer: NriBuffer | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private blitSet: NriDescriptorSet | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views' (the swap chain's).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private swapChainViewFormat: NriFormat = NriFormat.Unknown;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        // The sample's setting (-op <0..15>: a VkLogicOp value, COPY at start); -noUI: no overlay.
        selectedOperation: int = LOGIC_OP_COPY;
        noUI: boolean = false;
        // The cube's logic operation on a UINT view of the color buffer (D3D), not UNORM (Vulkan).
        private uintLogicOps: boolean = false;

        // The sample's camera: rotation (degrees about x, y, z) and position; the mouse as it last
        // saw it.
        private cameraRotation: number[] = [CAMERA_ROTATION[0], CAMERA_ROTATION[1], CAMERA_ROTATION[2]];
        private cameraPosition: number[] = [CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]];
        private buttons: boolean[] = [false, false, false];
        private mouseX: number = 0.0;
        private mouseY: number = 0.0;

        // Upload buffers: the common UBO, the lighting UBO, the push constants; the blit's constants.
        private constants: f32[] = [];
        // struct UBOBAS: ambientLightColor, lightPosition, lightColor, lightIntensity.
        private baselineConstants: f32[] = [
            1.0, 1.0, 1.0, 0.1,
            -3.0, -8.0, 6.0, -1.0,
            1.0, 1.0, 1.0, 1.0,
            50.0, 0.0, 0.0, 0.0,
        ];
        // The model matrix (identity) and the cube's color.
        private pushConstants: f32[] = [
            1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 1.0,
            0.75, 1.0, 1.0, 1.0,
        ];
        private blitConstants: f32[] = [0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.constants.push(0.0);
            }
            for (let i = 0; i < LOGIC_OP_COUNT; i++) {
                this.baselinePipelines.push(null);
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
            this.uintLogicOps = graphicsAPI != NriGraphicsAPI.VK;

            // Swap chain: blitted into through sRGB views, as the Donut example's sRGB back buffer.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.swapChainViewFormat;

            if (device.isFeatureSupported(NriFeature.LogicOp) == 0) {
                this.unsupportedReason = "This example needs logic operations in blend states (OutputMergerLogicOp, Vulkan's logicOp)";
                return 0;
            }

            // The background model and the cube map; the cube.
            this.background = device.loadGltfMesh(this.queue, BACKGROUND_PATH);
            const envmap = device.loadDdsTexture(this.queue, ENVMAP_PATH, 0);
            this.envmap = envmap;
            if (!this.background || !envmap) {
                console.log("Cannot load the model and the cube map: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            const envmapView = envmap.createCubeView(NriFormat.RGBA16_SFLOAT);
            this.envmapView = envmapView;
            if (!this.createCube(device)) {
                console.log("Cannot create the cube");
                return 0;
            }

            // Donut's common samplers: anisotropic and repeating for the cube map (the framework's:
            // trilinear, the device's maximum anisotropy), linear and clamped for the blit.
            const anisotropicWrap = device.createSampler(NriFilter.Linear, NriAddressMode.Repeat,
                Math.min(16, device.getMaxSamplerAnisotropy()));
            const linearClamp = device.createSampler(NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
            this.anisotropicWrap = anisotropicWrap;
            this.linearClamp = linearClamp;

            // The color buffer (RGBA8, its views as above) and the depth buffer, the swap chain's size.
            if (!this.createSizeTargets(device) || !anisotropicWrap || !linearClamp) {
                console.log("Cannot create the color and depth buffers");
                return 0;
            }
            const colorView = this.colorView;

            // The layouts: the sample's descriptor set, as one for both pipelines (the common UBO at
            // b0, the lighting UBO at b1, the cube map at t0 and its sampler at s0) and the cube's push
            // constants (b2: root constants); the blit's constants (b0) and its source (t0, s0).
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRange(0, 0, 2, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.addRootConstants(PUSH_REGISTER, PUSH_FLOATS * 4, NriStage.VertexPixel);
            const layout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
            this.layout = layout;
            const blitLayoutDesc = NriPipelineLayoutDesc.create();
            blitLayoutDesc.addRootConstants(0, BLIT_CONSTANT_FLOATS * 4, NriStage.Vertex);
            blitLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            blitLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            const blitLayout = device.createPipelineLayoutFromDesc(blitLayoutDesc);
            blitLayoutDesc.destroy();
            this.blitLayout = blitLayout;
            if (!layout || !blitLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The pipelines: logic_op_dynamic_state.hlsl's shaders, as compiled for the Donut example
            // (the cube's, created as drawn); Donut's blit shaders (rect_vs, blit_ps).
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : (graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv");
            this.shaders = `shaders/logic_op_dynamic_state/${folder}/logic_op_dynamic_state`;
            this.backgroundPipeline = this.createBackgroundPipeline(device, layout);
            this.blitPipeline = this.createBlitPipeline(device, blitLayout, `shaders/framework/${folder}`);
            if (!this.backgroundPipeline || !this.blitPipeline || !this.getBaselinePipeline(this.selectedOperation)) {
                console.log("Cannot load the logic operations shaders");
                return 0;
            }

            // The UBOs (a queued frame's each), the descriptor sets (a queued frame's, and the
            // blit's).
            const constantBuffer = device.createHostBuffer(queuedFrameNum * 2 * CONST_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const descriptorPool = device.createDescriptorPool(queuedFrameNum + 1, queuedFrameNum + 1, 2 * queuedFrameNum,
                queuedFrameNum + 1, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!constantBuffer || !descriptorPool || !colorView) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const commonView = constantBuffer.createConstantView(2 * i * CONST_STRIDE, CONST_STRIDE);
                const baselineView = constantBuffer.createConstantView((2 * i + 1) * CONST_STRIDE, CONST_STRIDE);
                const descriptorSet = descriptorPool.allocateDescriptorSet(layout, 0, 0);
                this.queuedFrames.push(new QueuedFrame(descriptorSet,
                    commonView, baselineView));
                if (!commonView || !baselineView || !descriptorSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                descriptorSet.updateDescriptor(0, 0, commonView);
                descriptorSet.updateDescriptor(0, 1, baselineView);
                descriptorSet.updateDescriptor(1, 0, envmapView);
                descriptorSet.updateDescriptor(2, 0, anisotropicWrap);
            }
            const blitSet = descriptorPool.allocateDescriptorSet(blitLayout, 0, 0);
            this.blitSet = blitSet;
            if (!blitSet) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }
            blitSet.updateDescriptor(0, 0, colorView);
            blitSet.updateDescriptor(1, 0, linearClamp);

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

        // The sample's model_data_creation, as the Donut example builds it: a cube of 8 vertices,
        // each with the normalized sum of its three faces' normals, scaled by 8 and moved by
        // (0, 1, 5). The sample draws it as 6 triangle strips of 4 indices separated by primitive
        // restarts; here (as in the Donut example) they are unrolled into a triangle list: a strip's
        // odd triangles with their first two vertices swapped, which keeps their winding. False if
        // its buffers can't be created.
        createCube(device: NriDevice): boolean {
            const corners = [
                0.0, 0.0, 0.0,
                1.0, 0.0, 0.0,
                1.0, 1.0, 0.0,
                0.0, 1.0, 0.0,
                0.0, 0.0, 1.0,
                1.0, 0.0, 1.0,
                1.0, 1.0, 1.0,
                0.0, 1.0, 1.0,
            ];
            const positions: f32[] = [];
            const normals: f32[] = [];
            for (let i = 0; i < 8; i++) {
                const x = corners[i * 3];
                const y = corners[i * 3 + 1];
                const z = corners[i * 3 + 2];
                positions.push(x * 8.0 + 0.0);
                positions.push(y * 8.0 + 1.0);
                positions.push(z * 8.0 + 5.0);
                // Each corner's faces: +1 or -1 along each axis.
                const n = normalize3(x * 2.0 - 1.0, y * 2.0 - 1.0, z * 2.0 - 1.0);
                normals.push(n[0]);
                normals.push(n[1]);
                normals.push(n[2]);
            }

            const strips = [
                0, 4, 3, 7,
                1, 0, 2, 3,
                2, 6, 1, 5,
                1, 5, 0, 4,
                4, 5, 7, 6,
                2, 3, 6, 7,
            ];
            const indices: int[] = [];
            for (let strip = 0; strip < 6; strip++) {
                for (let t = 0; t < 2; t++) {
                    const v = strip * 4 + t;
                    const first = strips[t % 2 == 0 ? v : v + 1];
                    const second = strips[t % 2 == 0 ? v + 1 : v];
                    const third = strips[v + 2];
                    indices.push(first);
                    indices.push(second);
                    indices.push(third);
                }
            }
            this.cubeIndexCount = indices.length;

            this.cubePositions = device.createUploadedBuffer(this.queue, Ref(positions[0]), positions.length * 4,
                NriBufferUsage.VertexBuffer);
            this.cubeNormals = device.createUploadedBuffer(this.queue, Ref(normals[0]), normals.length * 4,
                NriBufferUsage.VertexBuffer);
            this.cubeIndices = device.createUploadedBufferFromInts(this.queue, Ref(indices[0]), indices.length * 4,
                NriBufferUsage.IndexBuffer);
            if (!this.cubePositions || !this.cubeNormals) {
                return false;
            }
            return this.cubeIndices ? true : false;
        }

        // The background: the glTF loader's positions, reversed depth (greater passes), back faces
        // culled, counter-clockwise front faces. (The sample blends it, alpha over; its alpha is 1,
        // so that's a copy.)
        createBackgroundPipeline(device: NriDevice, layout: NriPipelineLayout) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${this.shaders}_background_vs.bin`, "background_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${this.shaders}_background_ps.bin`, "background_ps") != 0;
            }
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            desc.setCullMode(NriCullMode.Back);
            desc.setFrontCounterClockwise(1);
            desc.setColor(NriFormat.RGBA8_UNORM, NriColorWrite.RGBA);
            desc.setDepth(NriFormat.D32_SFLOAT, NriCompareOp.Greater, 1, 0);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        // The cube's pipeline for a logic operation, for its view of the color buffer (UINT on D3D):
        // positions and normals in streams of their own, reversed depth, back faces culled (clockwise
        // front faces), the logic operation instead of blending. Created on first use; null on
        // failure.
        getBaselinePipeline(logicOp: int): NriPipeline | null {
            const existing = this.baselinePipelines[logicOp];
            if (existing) {
                return new NriPipeline(existing.handle);
            }
            const device = this.device;
            const layout = this.layout;
            if (!device || !layout) {
                return null;
            }
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${this.shaders}_baseline_vs.bin`, "baseline_vs") != 0;
            if (loaded) {
                loaded = desc.addShaderPermutation(NriShaderStage.Pixel, `${this.shaders}_baseline_ps.bin`, "baseline_ps",
                    this.uintLogicOps ? "UINT_OUTPUT=1" : "UINT_OUTPUT=0") != 0;
            }
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            desc.addVertexAttributeFromStream("NORMAL", NriFormat.RGB32_SFLOAT, 0, 1);
            desc.setCullMode(NriCullMode.Back);
            desc.setColor(this.uintLogicOps ? NriFormat.RGBA8_UINT : NriFormat.RGBA8_UNORM, NriColorWrite.RGBA);
            // (After the color: NO_OP turns its writes off.)
            desc.setLogicOp(logicOp);
            desc.setDepth(NriFormat.D32_SFLOAT, NriCompareOp.Greater, 1, 0);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            if (!pipeline) {
                return null;
            }
            // A wrapper of its own (destroying nothing) for the caller: the list keeps the pipeline.
            const result = new NriPipeline(pipeline.handle);
            this.baselinePipelines[logicOp] = pipeline;
            return result;
        }

        // Donut's blit pipeline: rect_vs's quad (a triangle strip), blit_ps without texture arrays,
        // no culling, no depth.
        createBlitPipeline(device: NriDevice, layout: NriPipelineLayout, framework: string) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${framework}/rect_vs.bin`, "main") != 0;
            if (loaded) {
                loaded = desc.addShaderPermutation(NriShaderStage.Pixel, `${framework}/blit_ps.bin`, "main",
                    "TEXTURE_ARRAY=0") != 0;
            }
            desc.setTopology(NriTopology.TriangleStrip);
            desc.setColor(this.viewFormat, NriColorWrite.RGBA);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        // Waits for the frame that last used this frame's command allocator (and its UBOs).
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

        // The sample's overlay (its title, ApiVulkanSample's default).
        buildUI() {
            this.sample.imguiNewFrame();
            NriImgui.setNextWindowPos(10.0, 10.0);
            NriImgui.begin("Vulkan Example", 1);
            if (NriImgui.collapsingHeader("Settings", 1) != 0) {
                this.selectedOperation = NriImgui.combo("Logic operation", this.selectedOperation, LOGIC_OP_NAMES);
            }
            NriImgui.end();
            this.sample.imguiRender();
        }

        // The sample's update_uniform_buffers: its camera's matrices; the lighting UBO; into this
        // frame's slices.
        writeConstants(constantBuffer: NriBuffer, queuedFrameIndex: int) {
            const c = this.constants;
            const projection = samplePerspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR);
            // A "look at" camera: translation * rotation (about x, then y, then z).
            const r = this.cameraRotation;
            let rotationMatrix = multiply(rotation(radians(r[0]), 1.0, 0.0, 0.0), rotation(radians(r[1]), 0.0, 1.0, 0.0));
            rotationMatrix = multiply(rotationMatrix, rotation(radians(r[2]), 0.0, 0.0, 1.0));
            const p = this.cameraPosition;
            const view = multiply(translation(p[0], p[1], p[2]), rotationMatrix);
            for (let i = 0; i < 16; i++) {
                c[CONST_PROJECTION + i] = projection[i];
                c[CONST_VIEW + i] = view[i];
            }
            constantBuffer.write(2 * queuedFrameIndex * CONST_STRIDE, Ref(c[0]), CONST_FLOATS * 4);
            constantBuffer.write((2 * queuedFrameIndex + 1) * CONST_STRIDE, Ref(this.baselineConstants[0]),
                BASELINE_FLOATS * 4);
        }

        // The background (between NriCommandBuffer.beginRenderingWithDepth and NriCommandBuffer.endRendering, into the
        // UNORM view).
        recordBackground(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const layout = this.layout;
            const descriptorPool = this.descriptorPool;
            const descriptorSet = queuedFrame.descriptorSet;
            const pipeline = this.backgroundPipeline;
            const background = this.background;
            if (!layout || !descriptorPool || !descriptorSet || !pipeline || !background) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(layout);
            commandBuffer.setDescriptorSet(0, descriptorSet);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setVertexBuffer(0, background.getVertexBuffer(), 0, VERTEX_SIZE);
            commandBuffer.setIndexBuffer(background.getIndexBuffer(), 0, NriIndexType.UInt32);
            commandBuffer.drawIndexed(background.getIndexCount(), 1, 0, 0, 0);
        }

        // The cube, with the logic operation chosen in the overlay (between
        // NriCommandBuffer.beginRenderingWithDepth and NriCommandBuffer.endRendering, into the logic operation's view).
        recordCube(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const layout = this.layout;
            const descriptorPool = this.descriptorPool;
            const descriptorSet = queuedFrame.descriptorSet;
            const pipeline = this.getBaselinePipeline(this.selectedOperation);
            const cubePositions = this.cubePositions;
            const cubeNormals = this.cubeNormals;
            const cubeIndices = this.cubeIndices;
            if (!layout || !descriptorPool || !descriptorSet || !pipeline || !cubePositions || !cubeNormals || !cubeIndices) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(layout);
            commandBuffer.setDescriptorSet(0, descriptorSet);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setRootConstants(0, Ref(this.pushConstants[0]), PUSH_FLOATS * 4);
            commandBuffer.setVertexBuffer(0, cubePositions, 0, 12);
            commandBuffer.setVertexBuffer(1, cubeNormals, 0, 12);
            commandBuffer.setIndexBuffer(cubeIndices, 0, NriIndexType.UInt32);
            commandBuffer.drawIndexed(this.cubeIndexCount, 1, 0, 0, 0);
        }

        // The color buffer over the whole swap chain texture (between NriCommandBuffer.beginRendering and
        // NriCommandBuffer.endRendering), as Donut's BlitTexture draws it.
        recordBlit(commandBuffer: NriCommandBuffer) {
            const blitLayout = this.blitLayout;
            const blitPipeline = this.blitPipeline;
            const descriptorPool = this.descriptorPool;
            const blitSet = this.blitSet;
            if (!blitLayout || !blitPipeline || !descriptorPool || !blitSet) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(blitLayout);
            commandBuffer.setPipeline(blitPipeline);
            commandBuffer.setRootConstants(0, Ref(this.blitConstants[0]), BLIT_CONSTANT_FLOATS * 4);
            commandBuffer.setDescriptorSet(0, blitSet);
            commandBuffer.draw(4, 1, 0, 0);
        }

        // The scene into the color buffer: cleared to transparent black, depth to 0 (reversed); the
        // background through the UNORM view, the cube through the logic operation's.
        recordScene(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const colorAttachment = this.colorAttachment;
            const logicOpAttachment = this.logicOpAttachment;
            const depthAttachment = this.depthAttachment;
            if (!colorAttachment || !logicOpAttachment || !depthAttachment) {
                return;
            }
            commandBuffer.beginRenderingWithDepth(colorAttachment, depthAttachment);
            commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
            commandBuffer.clearDepth(0.0);
            this.recordBackground(commandBuffer, queuedFrame);
            commandBuffer.endRendering();
            commandBuffer.beginRenderingWithDepth(logicOpAttachment, depthAttachment);
            this.recordCube(commandBuffer, queuedFrame);
            commandBuffer.endRendering();
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain made
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
            this.destroySizeTargets();
            this.swapChain.recreate();
            this.sizeToSwapChain();
            this.createSizeTargets(device);
            // The blit reads the new color buffer.
            const blitSet = this.blitSet;
            const colorView = this.colorView;
            if (blitSet) {
                if (colorView) {
                    blitSet.updateDescriptor(0, 0, colorView);
                }
            }
        }

        // The color buffer (RGBA8: its UNORM attachment, the logic operations' one, UINT on D3D, and
        // the blit's sRGB view) and the depth buffer, at the swap chain's size. False if either can't
        // be created.
        createSizeTargets(device: NriDevice): boolean {
            const colorBuffer = device.createRenderTargetTexture(this.queue, this.width, this.height, NriFormat.RGBA8_UNORM);
            const depthTexture = device.createDepthTexture(this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.colorBuffer = colorBuffer;
            this.depthTexture = depthTexture;
            if (!colorBuffer || !depthTexture) {
                return false;
            }
            this.colorAttachment = colorBuffer.createColorAttachmentView(NriFormat.RGBA8_UNORM);
            this.logicOpAttachment = colorBuffer.createColorAttachmentView(
                this.uintLogicOps ? NriFormat.RGBA8_UINT : NriFormat.RGBA8_UNORM);
            this.colorView = colorBuffer.createView(NriFormat.RGBA8_SRGB);
            this.depthAttachment = depthTexture.createDepthAttachmentView(NriFormat.D32_SFLOAT);
            return true;
        }

        destroySizeTargets() {
            this.destroyDescriptor(this.colorAttachment);
            this.destroyDescriptor(this.logicOpAttachment);
            this.destroyDescriptor(this.colorView);
            this.destroyDescriptor(this.depthAttachment);
            this.destroyTexture(this.colorBuffer);
            this.destroyTexture(this.depthTexture);
            this.colorAttachment = null;
            this.logicOpAttachment = null;
            this.colorView = null;
            this.depthAttachment = null;
            this.colorBuffer = null;
            this.depthTexture = null;
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.handleMouse();
            const constantBuffer = this.constantBuffer;
            if (constantBuffer) {
                this.writeConstants(constantBuffer, queuedFrameIndex);
            }

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            const colorBuffer = this.colorBuffer;
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: the scene into the color buffer, the color buffer blitted into the swap
                // chain texture, the overlay over it.
                commandBuffer.begin();
                if (colorBuffer) {
                    commandBuffer.textureBarrier(colorBuffer, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
                    this.recordScene(commandBuffer, queuedFrame);
                    commandBuffer.textureBarrier(colorBuffer, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
                }
                if (this.imgui) {
                    this.sample.copyImguiData(commandBuffer);
                }
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                this.recordBlit(commandBuffer);
                if (this.imgui) {
                    this.sample.drawImgui(commandBuffer, this.viewFormat);
                }
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
                    this.destroyDescriptor(queuedFrame.commonView);
                    this.destroyDescriptor(queuedFrame.baselineView);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                this.destroyDescriptor(this.envmapView);
                this.destroyDescriptor(this.anisotropicWrap);
                this.destroyDescriptor(this.linearClamp);
                this.destroyDescriptor(this.colorAttachment);
                this.destroyDescriptor(this.logicOpAttachment);
                this.destroyDescriptor(this.colorView);
                this.destroyDescriptor(this.depthAttachment);
                this.destroyTexture(this.envmap);
                this.destroyTexture(this.colorBuffer);
                this.destroyTexture(this.depthTexture);
                const background = this.background;
                if (background) {
                    background.destroy();
                }
                this.destroyBuffer(this.cubePositions);
                this.destroyBuffer(this.cubeNormals);
                this.destroyBuffer(this.cubeIndices);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.backgroundPipeline);
                this.destroyPipeline(this.blitPipeline);
                for (const pipeline of this.baselinePipelines) {
                    this.destroyPipeline(pipeline);
                }
                this.destroyLayout(this.layout);
                this.destroyLayout(this.blitLayout);
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

        destroyTexture(texture: NriTexture | null) {
            if (texture) {
                texture.destroy();
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
        const logicOp = new LogicOpDynamicState(sample);
        // -op <0..15>: the logic operation at start (Vulkan's order: 3 is COPY); -noUI: no overlay.
        sample.addExampleOptionWithValues("-op", 1);
        sample.addExampleOption("-noUI");
        sample.useImgui();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-op" && i + 1 < argc) {
                i++;
                logicOp.selectedOperation = Math.min(Math.max(parseInt(Nri.getArg(argc, argv, i)), 0), LOGIC_OP_COUNT - 1);
            } else if (arg == "-noUI") {
                logicOp.noUI = true;
            }
        }
        return logicOp.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return LogicOpDynamicStateNri.main(argc, argv);
}

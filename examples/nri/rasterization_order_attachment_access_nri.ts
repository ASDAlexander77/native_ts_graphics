/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { multiply, rotation, translation, radians, samplePerspective } from "../../core/matrix";
import { MsvcRandom } from "../../core/random";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriGltfMesh, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueryPool, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace RasterizationOrderAttachmentAccessNri {
    // rasterization_order_attachment_access, rendered with NRI (NVIDIA Rendering Interface) and
    // NRIFramework instead of Donut and NVRHI: the same shaders (rasterization_order_attachment_access
    // .hlsl's), model (read as Donut's loadGltfMesh reads it) and background, through the NRI calls
    // core/nri/nri_interop.d.ts binds, with NRIFramework's ImGui for the sample's overlay. This
    // example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Rasterization Order Attachment Access";

    // The sample's model and background (Vulkan-Samples' assets), the KTX texture converted to DDS
    // at build time (see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const MODEL_PATH = "media/rasterization_order_attachment_access/geosphere.gltf";
    const BACKGROUND_PATH = "media/rasterization_order_attachment_access/vulkan_logo_full.dds";

    // NriDevice.loadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;

    // The sample's grid of transparent spheres: rows (x) by columns (y) by layers (z), one unit
    // apart and centered on the origin.
    const INSTANCE_ROW_COUNT = 4;
    const INSTANCE_COLUMN_COUNT = 4;
    const INSTANCE_LAYER_COUNT = 4;
    const INSTANCE_COUNT = INSTANCE_ROW_COUNT * INSTANCE_COLUMN_COUNT * INSTANCE_LAYER_COUNT;
    const INSTANCE_SCALE = 0.03;
    // struct Instance { float4x4 model; float4 color; }.
    const INSTANCE_FLOATS = 20;
    const INSTANCE_SIZE = INSTANCE_FLOATS * 4;
    const RANDOM_SEED = 42;

    // struct SceneConstants { float4x4 projection, view; float backgroundGrayscale; }, padded, as f32
    // offsets; a queued frame's in a 256-byte slice of the constant buffer (D3D12 constant buffer
    // views' alignment).
    const CONST_PROJECTION = 0;
    const CONST_VIEW = 16;
    const CONST_BACKGROUND_GRAYSCALE = 32;
    const CONST_FLOATS = 36;
    const CONST_STRIDE = 256;
    const BACKGROUND_GRAYSCALE = 0.3;

    // The draw's first instance (b1: 4 bytes of root constants).
    const DRAW_CONSTANTS_SIZE = 4;

    // The sample's camera: a "look at" camera 4 units back, 60 degrees vertically, reversed depth
    // from 256 to 0.1 (glm::perspective with near and far swapped).
    const CAMERA_POSITION = [0.0, 0.0, -4.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;
    // ApiVulkanSample's mouse controls: degrees per pixel dragged with the left button, zoom per
    // pixel with the right one, panning per pixel with the middle one.
    const ROTATION_SPEED = 1.0;
    const ZOOM_SPEED = 0.005;
    const PAN_SPEED = 0.01;

    // The GPU time's timestamps (before the background, after the spheres), a queued frame's each.
    const TIMESTAMPS = 2;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into: its command buffer, its descriptor sets (the
    // background's, the spheres'), the view of its slice of the scene constants, the buffer its
    // timestamps are copied into and whether it holds ones not read yet.
    class QueuedFrame {
        timestampsPending: boolean = false;

        constructor(public commandBuffer: NriCommandBuffer,
            public backgroundSet: NriDescriptorSet | null, public blendSet: NriDescriptorSet | null,
            public sceneView: NriDescriptor | null, public timestampBuffer: NriBuffer | null) {
        }
    }

    // printf's %.3f.
    function formatFixed3(value: number) {
        const scaled = Math.round(value * 1000.0);
        const whole = Math.floor(scaled / 1000);
        let fraction = `${scaled - whole * 1000}`;
        while (fraction.length < 3) {
            fraction = "0" + fraction;
        }
        return `${whole}.${fraction}`;
    }

    // -test: checks the last frame, read back, as the Donut example does: the corners are the gray
    // background; the translucent spheres, blended in rasterization order, color about 57% of it.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const xs = [0, width - 1, 0, width - 1];
        const ys = [0, 0, height - 1, height - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[ys[k] * width + xs[k]] & 0xFFFFFF;
            if (p != 0x959595) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not 149, 149, 149`;
            }
        }
        let colored = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            const high = Math.max(r, Math.max(g, b));
            const low = Math.min(r, Math.min(g, b));
            if (high - low >= 61) {
                colored++;
            }
        }
        const total = width * height;
        const percent = 100.0 * colored / total;
        console.log(`Colored: ${percent}% (${colored} of ${total} pixels)`);
        if (percent < 45.0 || percent > 70.0) {
            return `Colored: ${percent}% of the pixels, not 45% to 70%`;
        }
        return "";
    }

    // Port of Vulkan-Samples' rasterization_order_attachment_access (as
    // examples/rasterization_order_attachment_access.ts ports it) to NRI: 64 transparent spheres
    // over a background, each fragment blending itself over what it reads at its pixel
    // (programmable blending), into a storage texture of the swap chain's bytes (R32_UINT). With
    // rasterizer ordered views (NriFeature.RasterizerOrderedViews: D3D's ROVs, Vulkan's fragment
    // shader interlock), overlapping fragments of one draw take turns in primitive order, so a
    // single instanced draw does it; without, each sphere is drawn alone with a barrier after it
    // (each in a rendering pass of its own: barriers go between them). The background and the
    // spheres write the texture only (no color); a display pass decodes it into the sRGB swap chain
    // view.
    class RasterizationOrderAttachmentAccess {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private backgroundLayout: NriPipelineLayout | null = null;
        private blendLayout: NriPipelineLayout | null = null;
        private displayLayout: NriPipelineLayout | null = null;
        private backgroundPipeline: NriPipeline | null = null;
        private blendPipeline: NriPipeline | null = null;
        private blendRovPipeline: NriPipeline | null = null;
        private displayPipeline: NriPipeline | null = null;
        private displaySet: NriDescriptorSet | null = null;
        private mesh: NriGltfMesh | null = null;
        private background: NriTexture | null = null;
        private backgroundView: NriDescriptor | null = null;
        private sampler: NriDescriptor | null = null;
        private sceneConstantBuffer: NriBuffer | null = null;
        private instanceBuffer: NriBuffer | null = null;
        private instanceView: NriDescriptor | null = null;
        // The color texture (the swap chain's bytes, sRGB-encoded RGBA8 packed in a uint) for the
        // window's size: written by the pixel shaders, read by the display pass.
        private colorTexture: NriTexture | null = null;
        private colorStorageView: NriDescriptor | null = null;
        private colorView: NriDescriptor | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private queryPool: NriQueryPool | null = null;
        private querySize: int = 0;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views' (the swap chain's).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private swapChainViewFormat: NriFormat = NriFormat.Unknown;

        // The sample's camera: rotation (degrees about x, y, z) and position; the mouse as it last
        // saw it.
        private cameraRotation: number[] = [0.0, 0.0, 0.0];
        private cameraPosition: number[] = [CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]];
        private buttons: boolean[] = [false, false, false];
        private mouseX: number = 0.0;
        private mouseY: number = 0.0;

        // The sample's settings and statistics (-norov: start with a draw and a barrier per sphere);
        // -noUI: no overlay.
        rovSupported: boolean = false;
        rovEnabled: boolean = true;
        noUI: boolean = false;
        private gpuDrawTimeMs: number = 0.0;
        private hasGpuTime: boolean = false;

        // The UBO contents and the draw's root constants.
        private constants: f32[] = [];
        private drawConstants: f32[] = [0.0];

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

            // The sample's ROAA, where the device has rasterizer ordered views (else, as the Donut
            // example, a draw and a barrier per sphere).
            this.rovSupported = device.isFeatureSupported(NriFeature.RasterizerOrderedViews) != 0;
            this.rovEnabled = this.rovEnabled && this.rovSupported;

            // Swap chain: rendered through sRGB views, as Donut's (sRGB) back buffers.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.swapChainViewFormat;

            // The model and the background (KTX 1 files have no color space: the framework takes
            // color textures as sRGB).
            this.mesh = device.loadGltfMesh(this.queue, MODEL_PATH);
            const background = device.loadDdsTexture(this.queue, BACKGROUND_PATH, 1);
            this.background = background;
            if (!this.mesh || !background) {
                console.log("Cannot load the model and the background: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            const backgroundView = background.createView(NriFormat.RGBA8_SRGB);
            this.backgroundView = backgroundView;
            // Donut's LinearWrap: linear, repeating (one mip level, as the sample's texture).
            const sampler = device.createSamplerWithMipFilter(NriFilter.Linear, NriFilter.Linear, NriAddressMode.Repeat, 1);
            this.sampler = sampler;

            // The sample's descriptor set, split by pass as the Donut example does: the background's
            // uniforms, texture, sampler and color texture; the spheres' uniforms, first instance
            // (root constants), instances and color texture; the display pass's color texture.
            const backgroundLayoutDesc = NriPipelineLayoutDesc.create();
            backgroundLayoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            backgroundLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.VertexPixel, NriRangeFlags.None);
            backgroundLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.VertexPixel, NriRangeFlags.None);
            backgroundLayoutDesc.addRange(0, 1, 1, NriDescriptorType.StorageTexture, NriStage.VertexPixel, NriRangeFlags.None);
            this.backgroundLayout = device.createPipelineLayoutFromDesc(backgroundLayoutDesc);
            backgroundLayoutDesc.destroy();

            const blendLayoutDesc = NriPipelineLayoutDesc.create();
            blendLayoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            blendLayoutDesc.addRange(0, 1, 1, NriDescriptorType.StructuredBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            blendLayoutDesc.addRange(0, 1, 1, NriDescriptorType.StorageTexture, NriStage.VertexPixel, NriRangeFlags.None);
            blendLayoutDesc.addRootConstants(1, DRAW_CONSTANTS_SIZE, NriStage.VertexPixel);
            this.blendLayout = device.createPipelineLayoutFromDesc(blendLayoutDesc);
            blendLayoutDesc.destroy();

            const displayLayoutDesc = NriPipelineLayoutDesc.create();
            displayLayoutDesc.addRange(0, 2, 1, NriDescriptorType.Texture, NriStage.VertexPixel, NriRangeFlags.None);
            this.displayLayout = device.createPipelineLayoutFromDesc(displayLayoutDesc);
            displayLayoutDesc.destroy();

            const backgroundLayout = this.backgroundLayout;
            const blendLayout = this.blendLayout;
            const displayLayout = this.displayLayout;
            if (!backgroundLayout || !blendLayout || !displayLayout || !sampler) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The sample's pipelines: rasterization_order_attachment_access.hlsl's shaders, as
            // compiled for the Donut example (blend_ps with ROV=0, and ROV=1 where supported); no
            // depth; the background and the spheres write the color texture only (no color output),
            // the spheres' back faces culled (counter-clockwise triangles the front ones).
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : (graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv");
            const shaders = `shaders/rasterization_order_attachment_access/${folder}/rasterization_order_attachment_access`;
            this.backgroundPipeline = this.createPipeline(device, backgroundLayout, shaders, "fullscreen_vs", "background_ps", "", false,
                NriColorWrite.None);
            this.blendPipeline = this.createPipeline(device, blendLayout, shaders, "blend_vs", "blend_ps", "ROV=0", true, NriColorWrite.None);
            this.displayPipeline = this.createPipeline(device, displayLayout, shaders, "fullscreen_vs", "display_ps", "", false,
                NriColorWrite.RGBA);
            if (!this.backgroundPipeline || !this.blendPipeline || !this.displayPipeline) {
                console.log("Cannot load the rasterization order attachment access shaders");
                return 0;
            }
            if (this.rovSupported) {
                this.blendRovPipeline = this.createPipeline(device, blendLayout, shaders, "blend_vs", "blend_ps", "ROV=1", true,
                    NriColorWrite.None);
                if (!this.blendRovPipeline) {
                    console.log("Cannot load the rasterization order attachment access shaders");
                    return 0;
                }
            }

            // The uniforms, a queued frame's each; the instances (the sample's instance data).
            const sceneConstantBuffer = device.createHostBuffer(queuedFrameNum * CONST_STRIDE, NriBufferUsage.ConstantBuffer);
            this.sceneConstantBuffer = sceneConstantBuffer;
            const instanceBuffer = this.createInstanceBuffer(device);
            this.instanceBuffer = instanceBuffer;
            if (!sceneConstantBuffer || !instanceBuffer) {
                console.log("Cannot create the buffers");
                return 0;
            }
            const instanceView = instanceBuffer.createStructuredView(0);
            this.instanceView = instanceView;

            if (!this.createColorTexture(device) || !instanceView) {
                console.log("Cannot create the color texture");
                return 0;
            }
            const colorStorageView = this.colorStorageView;
            const colorView = this.colorView;
            if (!colorStorageView || !colorView) {
                console.log("Cannot create the color texture");
                return 0;
            }

            // The GPU time's timestamps, a queued frame's each.
            const queryPool = device.createTimestampQueryPool(queuedFrameNum * TIMESTAMPS);
            this.queryPool = queryPool;
            if (!queryPool) {
                console.log("Cannot create the timestamp queries");
                return 0;
            }
            this.querySize = queryPool.getQuerySize();

            // A queued frame's descriptor sets, and the display pass's.
            const descriptorPool = device.createDescriptorPoolWithBuffers(2 * queuedFrameNum + 1, queuedFrameNum, 2 * queuedFrameNum,
                queuedFrameNum + 1, 2 * queuedFrameNum, queuedFrameNum, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!descriptorPool) {
                console.log("Cannot create the descriptor pool");
                return 0;
            }
            const displaySet = descriptorPool.allocateDescriptorSet(displayLayout, 0, 0);
            this.displaySet = displaySet;
            if (!displaySet) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }
            displaySet.updateDescriptor(0, 0, colorView);
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const sceneView = sceneConstantBuffer.createConstantView(i * CONST_STRIDE, CONST_STRIDE);
                const backgroundSet = descriptorPool.allocateDescriptorSet(backgroundLayout, 0, 0);
                const blendSet = descriptorPool.allocateDescriptorSet(blendLayout, 0, 0);
                const timestampBuffer = device.createReadbackBuffer(TIMESTAMPS * this.querySize);
                this.queuedFrames.push(new QueuedFrame(new NriCommandBuffer(this.frames.commandBuffer(i).handle), backgroundSet, blendSet,
                    sceneView, timestampBuffer));
                if (!sceneView || !backgroundSet || !blendSet || !timestampBuffer) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                backgroundSet.updateDescriptor(0, 0, sceneView);
                backgroundSet.updateDescriptor(1, 0, backgroundView);
                backgroundSet.updateDescriptor(2, 0, sampler);
                backgroundSet.updateDescriptor(3, 0, colorStorageView);
                blendSet.updateDescriptor(0, 0, sceneView);
                blendSet.updateDescriptor(1, 0, instanceView);
                blendSet.updateDescriptor(2, 0, colorStorageView);
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

        // A pipeline of the shaders vs and ps (ps's permutation: "" for none), with the spheres'
        // positions and their back faces culled or a fullscreen triangle, the channels written; no
        // depth.
        createPipeline(device: NriDevice, pipelineLayout: NriPipelineLayout, shaders: string, vs: string, ps: string,
            permutation: string, spheres: boolean, writeMask: int) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_${vs}.bin`, vs) != 0;
            if (loaded) {
                loaded = permutation == ""
                    ? desc.addShader(NriShaderStage.Pixel, `${shaders}_${ps}.bin`, ps) != 0
                    : desc.addShaderPermutation(NriShaderStage.Pixel, `${shaders}_${ps}.bin`, ps, permutation) != 0;
            }
            if (spheres) {
                desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
                desc.setCullMode(NriCullMode.Back);
                desc.setFrontCounterClockwise(1);
            }
            desc.setColor(this.viewFormat, writeMask);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(pipelineLayout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        // The sample's instance data: the grid's transforms and random colors (alpha 0.2 to 1), in
        // a structured buffer; null on failure.
        createInstanceBuffer(device: NriDevice) {
            const random = new MsvcRandom(RANDOM_SEED);
            const instances: f32[] = [];
            for (let z = 0; z < INSTANCE_LAYER_COUNT; z++) {
                for (let y = 0; y < INSTANCE_COLUMN_COUNT; y++) {
                    for (let x = 0; x < INSTANCE_ROW_COUNT; x++) {
                        const px = x - (INSTANCE_ROW_COUNT - 1) * 0.5;
                        const py = y - (INSTANCE_COLUMN_COUNT - 1) * 0.5;
                        const pz = z - (INSTANCE_LAYER_COUNT - 1) * 0.5;
                        // glm::scale(glm::translate(mat4(1), pos), vec3(scale))
                        const model = [INSTANCE_SCALE, 0.0, 0.0, 0.0, 0.0, INSTANCE_SCALE, 0.0, 0.0,
                            0.0, 0.0, INSTANCE_SCALE, 0.0, px, py, pz, 1.0];
                        for (let i = 0; i < 16; i++) {
                            instances.push(model[i]);
                        }
                        // glm::vec4(random_float(), random_float(), random_float(),
                        // random_float() * 0.8f + 0.2f): MSVC evaluates the arguments right to
                        // left, so alpha takes the first number, red the last.
                        const alpha = random.nextFloat() * 0.8 + 0.2;
                        const blue = random.nextFloat();
                        const green = random.nextFloat();
                        const red = random.nextFloat();
                        instances.push(red);
                        instances.push(green);
                        instances.push(blue);
                        instances.push(alpha);
                    }
                }
            }
            return device.createUploadedStructuredBuffer(this.queue, Ref(instances[0]), INSTANCE_COUNT * INSTANCE_SIZE, INSTANCE_SIZE);
        }

        drawCallCount() {
            return this.rovEnabled ? 2 : INSTANCE_COUNT + 1;
        }

        barrierCount() {
            return this.rovEnabled ? 0 : INSTANCE_COUNT - 1;
        }

        // Waits for the frame that last used this frame's command allocator (and its UBO slice).
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
            if (this.rovSupported) {
                this.rovEnabled = NriImgui.checkbox("Enable ROAA", this.rovEnabled ? 1 : 0) != 0;
            } else {
                NriImgui.text("ROAA not supported on this device");
            }
            NriImgui.text(`Draw calls: ${this.drawCallCount()}`);
            NriImgui.text(`Barriers: ${this.barrierCount()}`);
            if (this.hasGpuTime) {
                NriImgui.text(`GPU time: ${formatFixed3(this.gpuDrawTimeMs)} ms`);
            }
            NriImgui.end();
            this.sample.imguiRender();
        }

        // The sample's update_scene_uniforms, into this frame's slice.
        updateSceneConstants(sceneConstantBuffer: NriBuffer, offset: int) {
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
            c[CONST_BACKGROUND_GRAYSCALE] = BACKGROUND_GRAYSCALE;
            sceneConstantBuffer.write(offset, Ref(c[0]), CONST_FLOATS * 4);
        }

        // The sample's GPU time: the background and the spheres this queued frame measured when it
        // was last recorded (the GPU has finished it: latencySleep waited for it).
        readTimestamps(queuedFrame: QueuedFrame) {
            const device = this.device;
            const timestampBuffer = queuedFrame.timestampBuffer;
            if (!device || !timestampBuffer || !queuedFrame.timestampsPending) {
                return;
            }
            const ms = device.readTimestampIntervalMs(timestampBuffer, 0, this.querySize);
            if (ms >= 0.0) {
                this.gpuDrawTimeMs = ms;
                this.hasGpuTime = true;
            }
            queuedFrame.timestampsPending = false;
        }

        // The color texture's writes before seen by the accesses after (a UAV barrier between pixel
        // shaders).
        colorBarrier(commandBuffer: NriCommandBuffer) {
            const colorTexture = this.colorTexture;
            if (!colorTexture) {
                return;
            }
            commandBuffer.textureBarrier(colorTexture, NriTextureState.PixelStorage, NriTextureState.PixelStorage);
        }

        // A rendering pass into the swap chain view (which the background and the spheres don't
        // write), the whole window's viewport.
        beginPass(commandBuffer: NriCommandBuffer, colorAttachment: NriDescriptor) {
            commandBuffer.beginRendering(colorAttachment);
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
        }

        // The background (a fullscreen triangle) into the color texture.
        recordBackground(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame, colorAttachment: NriDescriptor) {
            const backgroundLayout = this.backgroundLayout;
            const backgroundPipeline = this.backgroundPipeline;
            const backgroundSet = queuedFrame.backgroundSet;
            if (!backgroundLayout || !backgroundPipeline || !backgroundSet) {
                return;
            }
            this.beginPass(commandBuffer, colorAttachment);
            commandBuffer.setPipelineLayout(backgroundLayout);
            commandBuffer.setPipeline(backgroundPipeline);
            commandBuffer.setDescriptorSet(0, backgroundSet);
            commandBuffer.draw(3, 1, 0, 0);
            commandBuffer.endRendering();
        }

        // The spheres over it: one instanced draw with ROAA; else a draw per sphere, a barrier
        // between each two (outside rendering, so a pass per sphere).
        recordSpheres(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame, colorAttachment: NriDescriptor) {
            const blendLayout = this.blendLayout;
            const blendSet = queuedFrame.blendSet;
            const mesh = this.mesh;
            const pipeline = this.rovEnabled ? this.blendRovPipeline : this.blendPipeline;
            if (!blendLayout || !blendSet || !mesh || !pipeline) {
                return;
            }
            const draws = this.rovEnabled ? 1 : INSTANCE_COUNT;
            for (let draw = 0; draw < draws; draw++) {
                if (draw > 0) {
                    this.colorBarrier(commandBuffer);
                }
                this.beginPass(commandBuffer, colorAttachment);
                commandBuffer.setPipelineLayout(blendLayout);
                commandBuffer.setPipeline(pipeline);
                commandBuffer.setDescriptorSet(0, blendSet);
                Nri.storeInt32(Ref(this.drawConstants[0]), draw);
                commandBuffer.setRootConstants(0, Ref(this.drawConstants[0]), DRAW_CONSTANTS_SIZE);
                commandBuffer.setVertexBuffer(0, mesh.getVertexBuffer(), 0, VERTEX_SIZE);
                commandBuffer.setIndexBuffer(mesh.getIndexBuffer(), 0, NriIndexType.UInt32);
                commandBuffer.drawIndexed(mesh.getIndexCount(), this.rovEnabled ? INSTANCE_COUNT : 1, 0, 0, 0);
                commandBuffer.endRendering();
            }
        }

        // Writes this queued frame's timestamp index.
        writeTimestamp(commandBuffer: NriCommandBuffer, queuedFrameIndex: int, index: int) {
            const queryPool = this.queryPool;
            if (!queryPool) {
                return;
            }
            commandBuffer.writeTimestamp(queryPool, queuedFrameIndex * TIMESTAMPS + index);
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The color texture, for the window's size: read and written by pixel shaders, read by the
        // display pass, in whose state each frame finds it (zeroed: the background covers it before
        // anything reads it); false on failure.
        createColorTexture(device: NriDevice): boolean {
            const zeros: int[] = [];
            for (let i = 0; i < this.width * this.height; i++) {
                zeros.push(0);
            }
            const colorTexture = device.createStorageTextureWithData(this.queue, this.width, this.height, NriFormat.R32_UINT,
                Ref(zeros[0]), this.width * 4, NriTextureState.ShaderResource);
            this.colorTexture = colorTexture;
            if (!colorTexture) {
                return false;
            }
            this.colorStorageView = colorTexture.createStorageView(NriFormat.R32_UINT);
            this.colorView = colorTexture.createView(NriFormat.R32_UINT);
            return true;
        }

        destroyColorTexture() {
            this.destroyDescriptor(this.colorStorageView);
            this.destroyDescriptor(this.colorView);
            this.destroyTexture(this.colorTexture);
            this.colorStorageView = null;
            this.colorView = null;
            this.colorTexture = null;
        }

        // The sets' color texture slots: the current texture's views (the display set's and every
        // queued frame's background and blend sets).
        updateColorDescriptors() {
            const colorStorageView = this.colorStorageView;
            const colorView = this.colorView;
            const displaySet = this.displaySet;
            if (displaySet) {
                if (colorView) {
                    displaySet.updateDescriptor(0, 0, colorView);
                }
            }
            if (!colorStorageView) {
                return;
            }
            for (const queuedFrame of this.queuedFrames) {
                const backgroundSet = queuedFrame.backgroundSet;
                const blendSet = queuedFrame.blendSet;
                if (backgroundSet) {
                    backgroundSet.updateDescriptor(3, 0, colorStorageView);
                }
                if (blendSet) {
                    blendSet.updateDescriptor(2, 0, colorStorageView);
                }
            }
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain and the color texture made
        // again at its size (the sets pointed at the new one), once the GPU is done with the old ones.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (!this.swapChain.resized()) {
                return;
            }
            device.waitIdle();
            this.destroyColorTexture();
            this.swapChain.recreate();
            this.sizeToSwapChain();
            this.createColorTexture(device);
            this.updateColorDescriptors();
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            this.readTimestamps(queuedFrame);
            if (this.imgui) {
                this.buildUI();
            }
            this.handleMouse();

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
            const sceneConstantBuffer = this.sceneConstantBuffer;
            const colorTexture = this.colorTexture;
            const displayLayout = this.displayLayout;
            const displayPipeline = this.displayPipeline;
            const displaySet = this.displaySet;
            const queryPool = this.queryPool;
            if (!descriptorPool || !sceneConstantBuffer || !colorTexture || !displayLayout || !displayPipeline || !displaySet || !queryPool) {
                return;
            }
            const commandBuffer = queuedFrame.commandBuffer;
            this.updateSceneConstants(sceneConstantBuffer, queuedFrameIndex * CONST_STRIDE);

            commandBuffer.begin();
            if (this.imgui) {
                this.sample.copyImguiData(commandBuffer);
            }
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.textureBarrier(this.swapChain.texture(index), NriTextureState.Undefined, NriTextureState.ColorAttachment);

            // The background and the spheres, timed; a barrier between them (the previous frame's
            // display pass left the color texture readable by pixel shaders).
            commandBuffer.resetQueries(queryPool, queuedFrameIndex * TIMESTAMPS, TIMESTAMPS);
            commandBuffer.textureBarrier(colorTexture, NriTextureState.ShaderResource, NriTextureState.PixelStorage);
            this.writeTimestamp(commandBuffer, queuedFrameIndex, 0);
            this.recordBackground(commandBuffer, queuedFrame, this.swapChain.colorAttachment(index));
            this.colorBarrier(commandBuffer);
            this.recordSpheres(commandBuffer, queuedFrame, this.swapChain.colorAttachment(index));
            this.writeTimestamp(commandBuffer, queuedFrameIndex, 1);
            const timestampBuffer = queuedFrame.timestampBuffer;
            if (timestampBuffer) {
                commandBuffer.copyQueries(queryPool, queuedFrameIndex * TIMESTAMPS, TIMESTAMPS, timestampBuffer, 0);
                queuedFrame.timestampsPending = true;
            }

            // The color texture's bytes to the screen; the overlay over them.
            commandBuffer.textureBarrier(colorTexture, NriTextureState.PixelStorage, NriTextureState.ShaderResource);
            this.beginPass(commandBuffer, this.swapChain.colorAttachment(index));
            commandBuffer.setPipelineLayout(displayLayout);
            commandBuffer.setPipeline(displayPipeline);
            commandBuffer.setDescriptorSet(0, displaySet);
            commandBuffer.draw(3, 1, 0, 0);
            if (this.imgui) {
                this.sample.drawImgui(commandBuffer, this.viewFormat);
            }
            commandBuffer.endRendering();

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
                    this.destroyDescriptor(queuedFrame.sceneView);
                    this.destroyBuffer(queuedFrame.timestampBuffer);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                const queryPool = this.queryPool;
                if (queryPool) {
                    queryPool.destroy();
                }
                this.destroyDescriptor(this.backgroundView);
                this.destroyDescriptor(this.sampler);
                this.destroyDescriptor(this.instanceView);
                this.destroyDescriptor(this.colorStorageView);
                this.destroyDescriptor(this.colorView);
                this.destroyTexture(this.background);
                this.destroyTexture(this.colorTexture);
                const mesh = this.mesh;
                if (mesh) {
                    mesh.destroy();
                }
                this.destroyBuffer(this.sceneConstantBuffer);
                this.destroyBuffer(this.instanceBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.backgroundPipeline);
                this.destroyPipeline(this.blendPipeline);
                this.destroyPipeline(this.blendRovPipeline);
                this.destroyPipeline(this.displayPipeline);
                this.destroyPipelineLayout(this.backgroundLayout);
                this.destroyPipelineLayout(this.blendLayout);
                this.destroyPipelineLayout(this.displayLayout);
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

        destroyPipelineLayout(pipelineLayout: NriPipelineLayout | null) {
            if (pipelineLayout) {
                pipelineLayout.destroy();
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const roaa = new RasterizationOrderAttachmentAccess(sample);
        // -norov: start with a draw and a barrier per sphere; -noUI: no overlay.
        sample.addExampleOption("-norov");
        sample.addExampleOption("-noUI");
        sample.useImgui();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-norov") {
                roaa.rovEnabled = false;
            } else if (arg == "-noUI") {
                roaa.noUI = true;
            }
        }
        return roaa.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return RasterizationOrderAttachmentAccessNri.main(argc, argv);
}

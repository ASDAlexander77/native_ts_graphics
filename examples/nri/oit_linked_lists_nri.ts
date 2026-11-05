/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { multiply, rotation, translation, radians, samplePerspective } from "../../core/matrix";
import { MsvcRandom } from "../../core/random";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriGltfMesh, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace OitLinkedListsNri {
    // oit_linked_lists, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (oit_linked_lists.hlsl's), model (read as Donut's
    // loadGltfMesh reads it) and background, through the NRI calls core/nri/nri_interop.d.ts binds,
    // with NRIFramework's ImGui for the sample's overlay. This example creates everything it runs,
    // and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: OIT Linked Lists";

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): D3D11 (see initialize).
    const TEST_SKIPPED = 77;

    // The sample's model and background (Vulkan-Samples' assets), the KTX texture converted to DDS
    // at build time (see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const MODEL_PATH = "media/oit_linked_lists/geosphere.gltf";
    const BACKGROUND_PATH = "media/oit_linked_lists/vulkan_logo_full.dds";

    // NriDevice.loadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;

    // The sample's grid of transparent spheres: rows (x) by columns (y) by layers (z), one unit
    // apart and centered on the origin; INSTANCE_COUNT in oit_linked_lists.hlsl.
    const INSTANCE_ROW_COUNT = 4;
    const INSTANCE_COLUMN_COUNT = 4;
    const INSTANCE_LAYER_COUNT = 4;
    const INSTANCE_COUNT = INSTANCE_ROW_COUNT * INSTANCE_COLUMN_COUNT * INSTANCE_LAYER_COUNT;
    const INSTANCE_SCALE = 0.02;
    // struct Instance { float4x4 model; float4 color; }: 64 of them, 5120 bytes (a multiple of 256,
    // as D3D12's constant buffer views take).
    const INSTANCE_FLOATS = 20;
    const INSTANCE_BYTES = INSTANCE_COUNT * INSTANCE_FLOATS * 4;

    // The fragment buffer holds this many fragments per pixel on average; past that, fragments
    // are dropped.
    const FRAGMENTS_PER_PIXEL_AVERAGE = 8;
    // struct { uint next, color, depth; }.
    const FRAGMENT_SIZE = 12;
    const LINKED_LIST_END_SENTINEL = -1; // 0xFFFFFFFF

    const SORTED_FRAGMENT_MIN_COUNT = 1;
    const SORTED_FRAGMENT_MAX_COUNT = 16;

    // struct SceneConstants { float4x4 projection, view; float backgroundGrayscale; uint
    // sortFragments, fragmentMaxCount, sortedFragmentCount; }, as f32 offsets; a queued frame's in a
    // 256-byte slice of the constant buffer (D3D12 constant buffer views' alignment).
    const CONST_PROJECTION = 0;
    const CONST_VIEW = 16;
    const CONST_BACKGROUND_GRAYSCALE = 32;
    const CONST_SORT_FRAGMENTS = 33;
    const CONST_FRAGMENT_MAX_COUNT = 34;
    const CONST_SORTED_FRAGMENT_COUNT = 35;
    const CONST_FLOATS = 36;
    const CONST_STRIDE = 256;

    // The sample's camera: a "look at" camera 4 units back, 60 degrees vertically, reversed depth
    // from 256 to 0.1 (glm::perspective with near and far swapped).
    const CAMERA_POSITION = [0.0, 0.0, -4.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;
    // ApiVulkanSample's mouse controls: degrees per pixel dragged with the left button, zoom per
    // pixel with the right one, panning per pixel with the middle one; and the auto-rotation's
    // degrees per second.
    const ROTATION_SPEED = 1.0;
    const ZOOM_SPEED = 0.005;
    const PAN_SPEED = 0.01;
    const AUTO_ROTATION_SPEED = 5.0;

    // The sample's benchmark mode (--benchmark): simulated at 60 frames per second.
    const BENCHMARK_FRAME_TIME = 1.0 / 60.0;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into: its command buffer, its descriptor sets (the gather
    // pass's, the background's, the combine pass's) and the view of its slice of the scene
    // constants.
    class QueuedFrame {
        constructor(public commandBuffer: NriCommandBuffer,
            public gatherSet: NriDescriptorSet | null, public backgroundSet: NriDescriptorSet | null,
            public combineSet: NriDescriptorSet | null, public sceneView: NriDescriptor | null) {
        }
    }

    // -test: checks the last frame, read back, as the Donut example does: the corners are the gray
    // background; the translucent spheres blended over it make about 40% of the frame colored.
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
        if (percent < 25.0 || percent > 60.0) {
            return `Colored: ${percent}% of the pixels, not 25% to 60%`;
        }
        return "";
    }

    // Port of Vulkan-Samples' oit_linked_lists (as examples/oit_linked_lists.ts ports it) to NRI:
    // order-independent transparency with per-pixel linked lists. A gather pass draws 64 transparent
    // spheres without writing any color: each fragment's pixel shader takes the next slot of a
    // fragment buffer (an atomic counter) and swaps it in as the head of its pixel's list (an atomic
    // exchange on an R32_UINT texture). A combine pass then walks each pixel's list, sorts its
    // nearest fragments, and blends them over the background, resetting the list and the counter
    // for the next frame as it goes. Drawn straight into the sRGB swap chain view, as the Donut
    // example draws into its back buffer.
    class OitLinkedLists {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private gatherLayout: NriPipelineLayout | null = null;
        private backgroundLayout: NriPipelineLayout | null = null;
        private combineLayout: NriPipelineLayout | null = null;
        // Why the example can't run on the device (empty when it can).
        private unsupportedReason: string = "";
        private gatherPipeline: NriPipeline | null = null;
        private backgroundPipeline: NriPipeline | null = null;
        private combinePipeline: NriPipeline | null = null;
        private mesh: NriGltfMesh | null = null;
        private background: NriTexture | null = null;
        private backgroundView: NriDescriptor | null = null;
        private sampler: NriDescriptor | null = null;
        private sceneConstantBuffer: NriBuffer | null = null;
        private instanceConstantBuffer: NriBuffer | null = null;
        private instanceView: NriDescriptor | null = null;
        // The lists, for the window's size: a head per pixel, the fragments and their counter.
        private linkedListHead: NriTexture | null = null;
        private linkedListHeadView: NriDescriptor | null = null;
        private fragmentBuffer: NriBuffer | null = null;
        private fragmentBufferView: NriDescriptor | null = null;
        private fragmentCounter: NriBuffer | null = null;
        private fragmentCounterView: NriDescriptor | null = null;
        private fragmentMaxCount: int = 0;
        private descriptorPool: NriDescriptorPool | null = null;
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

        // The sample's settings (-nosort, -sorted <1..16>, -rotate, -grayscale <0..1>); -benchmark:
        // fixed simulation steps, as the sample's benchmark mode; -noUI: no overlay.
        sortFragments: boolean = true;
        cameraAutoRotation: boolean = false;
        sortedFragmentCount: int = SORTED_FRAGMENT_MAX_COUNT;
        backgroundGrayscale: number = 0.3;
        benchmark: boolean = false;
        noUI: boolean = false;

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

            // Swap chain: rendered through sRGB views, as Donut's (sRGB) back buffers.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.swapChainViewFormat;

            // The model and the background (KTX 1 files have no color space: the framework takes
            // color textures as sRGB).
            // NRI's D3D11 backend makes buffers of 4-byte structures raw buffers (to allow raw views
            // of them), while the shader's fragment counter is a RWStructuredBuffer<uint>, which
            // D3D11 binds as a structured buffer only.
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "NRI's D3D11 backend has no structured buffers of 4-byte structures (the fragment counter)";
                return 0;
            }

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

            // The sample's descriptor set, split by pass as the Donut example does: the gather pass's
            // scene and instance uniforms, list heads, fragment buffer and counter; the background's
            // scene uniform, texture and sampler; the combine pass's scene uniform, list heads,
            // fragments and counter.
            const gatherLayoutDesc = NriPipelineLayoutDesc.create();
            gatherLayoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            gatherLayoutDesc.addRange(0, 1, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            gatherLayoutDesc.addRange(0, 1, 1, NriDescriptorType.StorageTexture, NriStage.VertexPixel, NriRangeFlags.None);
            gatherLayoutDesc.addRange(0, 2, 1, NriDescriptorType.StorageStructuredBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            gatherLayoutDesc.addRange(0, 3, 1, NriDescriptorType.StorageStructuredBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            this.gatherLayout = device.createPipelineLayoutFromDesc(gatherLayoutDesc);
            gatherLayoutDesc.destroy();

            const backgroundLayoutDesc = NriPipelineLayoutDesc.create();
            backgroundLayoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            backgroundLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.VertexPixel, NriRangeFlags.None);
            backgroundLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.VertexPixel, NriRangeFlags.None);
            this.backgroundLayout = device.createPipelineLayoutFromDesc(backgroundLayoutDesc);
            backgroundLayoutDesc.destroy();

            const combineLayoutDesc = NriPipelineLayoutDesc.create();
            combineLayoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            combineLayoutDesc.addRange(0, 1, 1, NriDescriptorType.StorageTexture, NriStage.VertexPixel, NriRangeFlags.None);
            combineLayoutDesc.addRange(0, 2, 1, NriDescriptorType.StorageStructuredBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            combineLayoutDesc.addRange(0, 3, 1, NriDescriptorType.StorageStructuredBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            this.combineLayout = device.createPipelineLayoutFromDesc(combineLayoutDesc);
            combineLayoutDesc.destroy();

            const gatherLayout = this.gatherLayout;
            const backgroundLayout = this.backgroundLayout;
            const combineLayout = this.combineLayout;
            if (!gatherLayout || !backgroundLayout || !combineLayout || !sampler) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The sample's pipelines: oit_linked_lists.hlsl's shaders, as compiled for the Donut
            // example; no culling, no depth test; the gather pass writes no color (the sample's
            // render pass has no attachments), the combined fragments blend over the background
            // (Donut's AlphaOver: color source alpha over, alpha one over).
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : (graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv");
            const shaders = `shaders/oit_linked_lists/${folder}/oit_linked_lists`;
            this.gatherPipeline = this.createPipeline(device, gatherLayout, shaders, "gather_vs", "gather_ps", true, NriColorWrite.None, false);
            this.backgroundPipeline = this.createPipeline(device, backgroundLayout, shaders, "fullscreen_vs", "background_ps", false,
                NriColorWrite.RGBA, false);
            this.combinePipeline = this.createPipeline(device, combineLayout, shaders, "combine_vs", "combine_ps", false,
                NriColorWrite.RGBA, true);
            if (!this.gatherPipeline || !this.backgroundPipeline || !this.combinePipeline) {
                console.log("Cannot load the oit linked lists shaders");
                return 0;
            }

            // The uniforms: the scene's, a queued frame's each; the instances', written once (the
            // sample's fill_instance_data).
            const sceneConstantBuffer = device.createHostBuffer(queuedFrameNum * CONST_STRIDE, NriBufferUsage.ConstantBuffer);
            const instanceConstantBuffer = device.createHostBuffer(INSTANCE_BYTES, NriBufferUsage.ConstantBuffer);
            this.sceneConstantBuffer = sceneConstantBuffer;
            this.instanceConstantBuffer = instanceConstantBuffer;
            if (!sceneConstantBuffer || !instanceConstantBuffer) {
                console.log("Cannot create the constant buffers");
                return 0;
            }
            this.fillInstanceData(instanceConstantBuffer);
            const instanceView = instanceConstantBuffer.createConstantView(0, INSTANCE_BYTES);
            this.instanceView = instanceView;

            // The lists, for the window's size.
            if (!this.createSizedResources(device) || !instanceView) {
                console.log("Cannot create the linked lists");
                return 0;
            }
            const linkedListHeadView = this.linkedListHeadView;
            const fragmentBufferView = this.fragmentBufferView;
            const fragmentCounterView = this.fragmentCounterView;
            if (!linkedListHeadView || !fragmentBufferView || !fragmentCounterView) {
                return 0;
            }

            // A queued frame's descriptor sets.
            const descriptorPool = device.createDescriptorPoolWithBuffers(3 * queuedFrameNum, queuedFrameNum, 4 * queuedFrameNum,
                queuedFrameNum, 2 * queuedFrameNum, 0, 4 * queuedFrameNum, 0);
            this.descriptorPool = descriptorPool;
            if (!descriptorPool) {
                console.log("Cannot create the descriptor pool");
                return 0;
            }
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const sceneView = sceneConstantBuffer.createConstantView(i * CONST_STRIDE, CONST_STRIDE);
                const gatherSet = descriptorPool.allocateDescriptorSet(gatherLayout, 0, 0);
                const backgroundSet = descriptorPool.allocateDescriptorSet(backgroundLayout, 0, 0);
                const combineSet = descriptorPool.allocateDescriptorSet(combineLayout, 0, 0);
                this.queuedFrames.push(new QueuedFrame(this.frames.commandBuffer(i), gatherSet, backgroundSet,
                    combineSet, sceneView));
                if (!sceneView || !gatherSet || !backgroundSet || !combineSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                gatherSet.updateDescriptor(0, 0, sceneView);
                gatherSet.updateDescriptor(1, 0, instanceView);
                gatherSet.updateDescriptor(2, 0, linkedListHeadView);
                gatherSet.updateDescriptor(3, 0, fragmentBufferView);
                gatherSet.updateDescriptor(4, 0, fragmentCounterView);
                backgroundSet.updateDescriptor(0, 0, sceneView);
                backgroundSet.updateDescriptor(1, 0, backgroundView);
                backgroundSet.updateDescriptor(2, 0, sampler);
                combineSet.updateDescriptor(0, 0, sceneView);
                combineSet.updateDescriptor(1, 0, linkedListHeadView);
                combineSet.updateDescriptor(2, 0, fragmentBufferView);
                combineSet.updateDescriptor(3, 0, fragmentCounterView);
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

        // A pipeline of the shaders vs and ps: with positions (the gather pass's model) or no vertex
        // input, the channels written, blended (AlphaOver) or not; no culling, no depth.
        createPipeline(device: NriDevice, pipelineLayout: NriPipelineLayout, shaders: string, vs: string, ps: string,
            positions: boolean, writeMask: int, blend: boolean) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_${vs}.bin`, vs) != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_${ps}.bin`, ps) != 0;
            }
            if (positions) {
                desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            }
            desc.setColor(this.viewFormat, writeMask);
            if (blend) {
                desc.setBlend(NriBlendFactor.SrcAlpha, NriBlendFactor.OneMinusSrcAlpha, NriBlendOp.Add,
                    NriBlendFactor.One, NriBlendFactor.OneMinusSrcAlpha, NriBlendOp.Add);
            }
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(pipelineLayout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        // The sample's create_fragment_resources and clear_sized_resources: a list head per pixel
        // (all empty), room for FRAGMENTS_PER_PIXEL_AVERAGE fragments per pixel, and the counter
        // (0), all read and written by pixel shaders; false on failure.
        createSizedResources(device: NriDevice): boolean {
            const width = this.width;
            const height = this.height;
            this.fragmentMaxCount = width * height * FRAGMENTS_PER_PIXEL_AVERAGE;
            const heads: int[] = [];
            for (let i = 0; i < width * height; i++) {
                heads.push(LINKED_LIST_END_SENTINEL);
            }
            const linkedListHead = device.createStorageTextureWithData(this.queue, width, height, NriFormat.R32_UINT, Ref(heads[0]),
                width * 4, NriTextureState.PixelStorage);
            this.linkedListHead = linkedListHead;
            this.fragmentBuffer = device.createUninitializedStorageBuffer(this.queue, this.fragmentMaxCount * FRAGMENT_SIZE, FRAGMENT_SIZE,
                NriBufferState.PixelStorage);
            const zero: int[] = [0];
            this.fragmentCounter = device.createStorageBufferFromInts(this.queue, Ref(zero[0]), 4, 4, NriBufferState.PixelStorage);
            const fragmentBuffer = this.fragmentBuffer;
            const fragmentCounter = this.fragmentCounter;
            if (!linkedListHead || !fragmentBuffer || !fragmentCounter) {
                return false;
            }
            this.linkedListHeadView = linkedListHead.createStorageView(NriFormat.R32_UINT);
            this.fragmentBufferView = fragmentBuffer.createStructuredView(1);
            this.fragmentCounterView = fragmentCounter.createStructuredView(1);
            return true;
        }

        destroySizedResources() {
            this.destroyDescriptor(this.linkedListHeadView);
            this.destroyDescriptor(this.fragmentBufferView);
            this.destroyDescriptor(this.fragmentCounterView);
            this.destroyTexture(this.linkedListHead);
            this.destroyBuffer(this.fragmentBuffer);
            this.destroyBuffer(this.fragmentCounter);
            this.linkedListHeadView = null;
            this.fragmentBufferView = null;
            this.fragmentCounterView = null;
            this.linkedListHead = null;
            this.fragmentBuffer = null;
            this.fragmentCounter = null;
        }

        // Every queued frame's gather and combine sets pointed at the current lists.
        updateSizedDescriptors() {
            const linkedListHeadView = this.linkedListHeadView;
            const fragmentBufferView = this.fragmentBufferView;
            const fragmentCounterView = this.fragmentCounterView;
            if (!linkedListHeadView || !fragmentBufferView || !fragmentCounterView) {
                return;
            }
            for (const queuedFrame of this.queuedFrames) {
                const gatherSet = queuedFrame.gatherSet;
                const combineSet = queuedFrame.combineSet;
                if (gatherSet) {
                    gatherSet.updateDescriptor(2, 0, linkedListHeadView);
                    gatherSet.updateDescriptor(3, 0, fragmentBufferView);
                    gatherSet.updateDescriptor(4, 0, fragmentCounterView);
                }
                if (combineSet) {
                    combineSet.updateDescriptor(1, 0, linkedListHeadView);
                    combineSet.updateDescriptor(2, 0, fragmentBufferView);
                    combineSet.updateDescriptor(3, 0, fragmentCounterView);
                }
            }
        }

        // The sample's fill_instance_data: the grid's transforms and random colors (alpha 0.2 to 1).
        fillInstanceData(instanceConstantBuffer: NriBuffer) {
            const random = new MsvcRandom(1);
            const instances: f32[] = [];
            for (let l = 0; l < INSTANCE_LAYER_COUNT; l++) {
                for (let c = 0; c < INSTANCE_COLUMN_COUNT; c++) {
                    for (let r = 0; r < INSTANCE_ROW_COUNT; r++) {
                        const x = r - (INSTANCE_ROW_COUNT - 1) * 0.5;
                        const y = c - (INSTANCE_COLUMN_COUNT - 1) * 0.5;
                        const z = l - (INSTANCE_LAYER_COUNT - 1) * 0.5;
                        // glm::scale(glm::translate(mat4(1), (x, y, z)), vec3(scale))
                        const model = [INSTANCE_SCALE, 0.0, 0.0, 0.0, 0.0, INSTANCE_SCALE, 0.0, 0.0,
                            0.0, 0.0, INSTANCE_SCALE, 0.0, x, y, z, 1.0];
                        for (let i = 0; i < 16; i++) {
                            instances.push(model[i]);
                        }
                        instances.push(random.nextFloat());
                        instances.push(random.nextFloat());
                        instances.push(random.nextFloat());
                        instances.push(random.nextFloat() * 0.8 + 0.2);
                    }
                }
            }
            instanceConstantBuffer.write(0, Ref(instances[0]), INSTANCE_BYTES);
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

        // The camera's auto-rotation: the frame's time (Donut's test mode: a float's 1/60 second;
        // -benchmark: 1/60 second).
        animate() {
            if (!this.cameraAutoRotation) {
                return;
            }
            let deltaTime = this.sample.getFrameTime();
            if (this.benchmark) {
                deltaTime = BENCHMARK_FRAME_TIME;
            } else if (this.test) {
                deltaTime = Math.fround(1.0 / 60.0);
            }
            this.cameraRotation[0] += deltaTime * AUTO_ROTATION_SPEED;
            this.cameraRotation[1] += deltaTime * AUTO_ROTATION_SPEED;
        }

        // The sample's overlay (its title, ApiVulkanSample's default).
        buildUI() {
            this.sample.imguiNewFrame();
            NriImgui.setNextWindowPos(10.0, 10.0);
            NriImgui.begin("Vulkan Example", 1);
            if (NriImgui.collapsingHeader("Settings", 1) != 0) {
                this.sortFragments = NriImgui.checkbox("Sort fragments", this.sortFragments ? 1 : 0) != 0;
                this.cameraAutoRotation = NriImgui.checkbox("Camera auto-rotation", this.cameraAutoRotation ? 1 : 0) != 0;
                this.sortedFragmentCount = NriImgui.sliderInt("Sorted fragments per pixel", this.sortedFragmentCount,
                    SORTED_FRAGMENT_MIN_COUNT, SORTED_FRAGMENT_MAX_COUNT);
                this.backgroundGrayscale = NriImgui.sliderFloat("Background grayscale", this.backgroundGrayscale, 0.0, 1.0);
            }
            NriImgui.end();
            this.sample.imguiRender();
        }

        // The sample's update_scene_constants: its camera's matrices and the settings, into this
        // frame's slice.
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
            c[CONST_BACKGROUND_GRAYSCALE] = this.backgroundGrayscale;
            Nri.storeInt32(Ref(c[CONST_SORT_FRAGMENTS]), this.sortFragments ? 1 : 0);
            Nri.storeInt32(Ref(c[CONST_FRAGMENT_MAX_COUNT]), this.fragmentMaxCount);
            Nri.storeInt32(Ref(c[CONST_SORTED_FRAGMENT_COUNT]), this.sortedFragmentCount);
            sceneConstantBuffer.write(offset, Ref(c[0]), CONST_FLOATS * 4);
        }

        // The lists' writes before seen by the accesses after (the sample's buffer barriers): UAV
        // barriers between pixel shaders.
        listBarriers(commandBuffer: NriCommandBuffer) {
            const linkedListHead = this.linkedListHead;
            const fragmentBuffer = this.fragmentBuffer;
            const fragmentCounter = this.fragmentCounter;
            if (!linkedListHead || !fragmentBuffer || !fragmentCounter) {
                return;
            }
            commandBuffer.textureBarrier(linkedListHead, NriTextureState.PixelStorage, NriTextureState.PixelStorage);
            commandBuffer.bufferBarrier(fragmentBuffer, NriBufferState.PixelStorage, NriBufferState.PixelStorage);
            commandBuffer.bufferBarrier(fragmentCounter, NriBufferState.PixelStorage, NriBufferState.PixelStorage);
        }

        // Gather pass: every sphere's fragments into the lists (rendering into the swap chain view,
        // which it doesn't write).
        recordGather(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame, colorAttachment: NriDescriptor) {
            const gatherLayout = this.gatherLayout;
            const gatherPipeline = this.gatherPipeline;
            const gatherSet = queuedFrame.gatherSet;
            const mesh = this.mesh;
            if (!gatherLayout || !gatherPipeline || !gatherSet || !mesh) {
                return;
            }
            commandBuffer.beginRendering(colorAttachment);
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(gatherLayout);
            commandBuffer.setPipeline(gatherPipeline);
            commandBuffer.setDescriptorSet(0, gatherSet);
            commandBuffer.setVertexBuffer(0, mesh.getVertexBuffer(), 0, VERTEX_SIZE);
            commandBuffer.setIndexBuffer(mesh.getIndexBuffer(), 0, NriIndexType.UInt32);
            commandBuffer.drawIndexed(mesh.getIndexCount(), INSTANCE_COUNT, 0, 0, 0);
            commandBuffer.endRendering();
        }

        // A fullscreen triangle of the pipeline with its layout and set (between
        // NriCommandBuffer.beginRendering and NriCommandBuffer.endRendering).
        drawFullscreen(commandBuffer: NriCommandBuffer, pipelineLayout: NriPipelineLayout | null,
            pipeline: NriPipeline | null, set: NriDescriptorSet | null) {
            if (!pipelineLayout || !pipeline || !set) {
                return;
            }
            commandBuffer.setPipelineLayout(pipelineLayout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setDescriptorSet(0, set);
            commandBuffer.draw(3, 1, 0, 0);
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain and the lists (a head per
        // pixel, the fragments' room) made again at its size (the sets pointed at the new ones), once
        // the GPU is done with the old ones.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (!this.swapChain.resized()) {
                return;
            }
            device.waitIdle();
            this.destroySizedResources();
            this.swapChain.recreate();
            this.sizeToSwapChain();
            this.createSizedResources(device);
            this.updateSizedDescriptors();
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
            const sceneConstantBuffer = this.sceneConstantBuffer;
            if (!descriptorPool || !sceneConstantBuffer) {
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

            // Gather pass, after the last frame's combine pass reset the lists.
            this.listBarriers(commandBuffer);
            this.recordGather(commandBuffer, queuedFrame, this.swapChain.colorAttachment(index));
            this.listBarriers(commandBuffer);

            // Combine pass: the background, then the lists blended over it; the overlay over them.
            commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            this.drawFullscreen(commandBuffer, this.backgroundLayout, this.backgroundPipeline, queuedFrame.backgroundSet);
            this.drawFullscreen(commandBuffer, this.combineLayout, this.combinePipeline, queuedFrame.combineSet);
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
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                this.destroyDescriptor(this.backgroundView);
                this.destroyDescriptor(this.sampler);
                this.destroyDescriptor(this.instanceView);
                this.destroySizedResources();
                this.destroyTexture(this.background);
                const mesh = this.mesh;
                if (mesh) {
                    mesh.destroy();
                }
                this.destroyBuffer(this.sceneConstantBuffer);
                this.destroyBuffer(this.instanceConstantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.gatherPipeline);
                this.destroyPipeline(this.backgroundPipeline);
                this.destroyPipeline(this.combinePipeline);
                this.destroyPipelineLayout(this.gatherLayout);
                this.destroyPipelineLayout(this.backgroundLayout);
                this.destroyPipelineLayout(this.combineLayout);
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
        const oit = new OitLinkedLists(sample);
        // -nosort: fragments blended unsorted; -sorted <1..16>: sorted fragments per pixel; -rotate:
        // camera auto-rotation; -grayscale <0..1>: the background's brightness; -benchmark: 1/60
        // second per frame; -noUI: no overlay.
        sample.addExampleOption("-nosort");
        sample.addExampleOptionWithValues("-sorted", 1);
        sample.addExampleOption("-rotate");
        sample.addExampleOptionWithValues("-grayscale", 1);
        sample.addExampleOption("-benchmark");
        sample.addExampleOption("-noUI");
        sample.useImgui();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-nosort") {
                oit.sortFragments = false;
            } else if (arg == "-rotate") {
                oit.cameraAutoRotation = true;
            } else if (arg == "-sorted" && i + 1 < argc) {
                i++;
                oit.sortedFragmentCount = Math.min(Math.max(parseInt(Nri.getArg(argc, argv, i)), SORTED_FRAGMENT_MIN_COUNT),
                    SORTED_FRAGMENT_MAX_COUNT);
            } else if (arg == "-grayscale" && i + 1 < argc) {
                i++;
                oit.backgroundGrayscale = Math.min(Math.max(parseFloat(Nri.getArg(argc, argv, i)), 0.0), 1.0);
            } else if (arg == "-benchmark") {
                oit.benchmark = true;
            } else if (arg == "-noUI") {
                oit.noUI = true;
            }
        }
        return oit.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return OitLinkedListsNri.main(argc, argv);
}

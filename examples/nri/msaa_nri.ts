/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { multiply, reversedPerspective, vulkanStyleProjection, toDonutClip } from "../../core/matrix";
import { DonutFirstPersonCamera } from "../../core/donut_first_person_camera";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriGltfModel, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace MsaaNri {
    // msaa, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut and
    // NVRHI: the same shaders (msaa.hlsl's and msaa_post.hlsl's), scene (read as Donut's
    // loadGltfModel reads it) and textures, through the NRI calls core/nri/nri_interop.d.ts binds,
    // with NRIFramework's ImGui for the sample's overlay. This example creates everything it runs,
    // and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: MSAA";

    // The sample's scene (Vulkan-Samples' assets): a glTF file whose base color textures, KTX 1
    // ASTC, are decoded to DDS at build time (see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const SCENE_DIR = "media/msaa/space_module/";
    const SCENE_PATH = SCENE_DIR + "SpaceModule.gltf";

    // NriGltfModel.load's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_FLOATS = 8;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;
    const NORMAL_OFFSET = 12;
    const TEXCOORD_OFFSET = 24;

    // struct SceneConstants { float4x4 viewProj; float4 lightColor, lightDirection; }, as f32
    // offsets, a queued frame's in a constant buffer view of CONST_VIEW_SIZE bytes (a multiple of
    // 256, D3D12's).
    const CONST_VIEW_PROJ = 0;
    const CONST_LIGHT_COLOR = 16;
    const CONST_LIGHT_DIRECTION = 20;
    const CONST_FLOATS = 24;
    const CONST_VIEW_SIZE = 256;
    // The draws' push constants (b1: root constants): their node's transform.
    const MODEL_FLOATS = 16;
    const MODEL_SIZE = MODEL_FLOATS * 4;
    // struct PostConstants { float2 nearFar; }, padded to a float4, in a constant buffer view of 256
    // bytes.
    const POST_FLOATS = 4;
    const POST_VIEW_SIZE = 256;

    // The framework's depth format (get_suitable_depth_format's first choice), reversed.
    const DEPTH_FORMAT = NriFormat.D32_SFLOAT;

    // The scene's camera node (main_camera): position, and orientation (x, y, z, w), its
    // perspective's vertical field of view and depth range.
    const CAMERA_POSITION = [-260.0, 190.0, 80.0];
    const CAMERA_ROTATION = [-0.0059817, -0.6014712, -0.0073468, 0.7988383];
    const CAMERA_FOV = 1.0;
    const Z_NEAR = 1.0;
    const Z_FAR = 4000.0;
    // The sample's free camera: 50 units per step, times its speed multiplier of 3, per second;
    // Donut's FirstPersonCamera's rotation speed.
    const CAMERA_MOVE_SPEED = 150.0;
    const CAMERA_ROTATE_SPEED = 0.005;

    // The scene's directional light: white, intensity 1, on a node with this rotation (x, y, z, w).
    const LIGHT_COLOR = [1.0, 1.0, 1.0, 1.0];
    const LIGHT_ROTATION = [0.0, 0.0, 0.258819, 0.9659258];

    // The sample counts from most to least preferred as the default: "On Mali GPUs 4X MSAA is
    // recommended as best performance/quality trade-off".
    const SAMPLE_COUNTS = [4, 2, 8, 16, 32, 64, 1];

    // The depth resolve modes, as Donut's ResolveMode (NriDevice.getDepthResolveModes' bits), from most to
    // least preferred as the default.
    const RESOLVE_NONE = 0;
    const RESOLVE_SAMPLE_ZERO = 1;
    const RESOLVE_AVERAGE = 2;
    const RESOLVE_MIN = 3;
    const RESOLVE_MAX = 4;
    const DEPTH_RESOLVE_MODES = [RESOLVE_SAMPLE_ZERO, RESOLVE_MIN, RESOLVE_MAX, RESOLVE_AVERAGE];

    // The color resolve methods.
    enum MsaaResolve {
        OnWriteback = 0,
        Separate = 1
    }

    // The scene's pipelines, per sample count.
    enum SceneVariant {
        Opaque = 0,
        OpaqueFlipped = 1,
        Blend = 2
    }
    const VARIANT_COUNT = 3;

    // Bounds start out inverted.
    const HUGE = 1.0e30;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    function sampleCountName(count: int) {
        return count == 1 ? "No MSAA" : `${count}X MSAA`;
    }

    function resolveModeName(mode: int) {
        if (mode == RESOLVE_SAMPLE_ZERO) {
            return "Sample 0";
        }
        if (mode == RESOLVE_AVERAGE) {
            return "Average";
        }
        if (mode == RESOLVE_MIN) {
            return "Min";
        }
        if (mode == RESOLVE_MAX) {
            return "Max";
        }
        return "None";
    }

    // The share of the pixels in [low, high], as the Donut example's TestCheck.share reports it.
    function share(count: int, total: int, low: number, high: number, name: string) {
        const percent = 100.0 * count / total;
        console.log(`${name}: ${percent}% (${count} of ${total} pixels)`);
        if (percent < low || percent > high) {
            return `${name}: ${percent}% of the pixels, not ${low}% to ${high}%`;
        }
        return "";
    }

    // -test: checks the last frame, read back, as the Donut example does: the space station
    // interior fills it (80% to 98% of the pixels not near black), its white panels 4% to 15%.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const total = width * height;
        let dark = 0;
        let white = 0;
        for (let i = 0; i < total; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r <= 20 && g <= 20 && b <= 20) {
                dark++;
            }
            if (r >= 221 && g >= 221 && b >= 221) {
                white++;
            }
        }
        const lit = share(total - dark, total, 80.0, 98.0, "Lit");
        if (lit != "") {
            return lit;
        }
        return share(white, total, 4.0, 15.0, "White");
    }

    // glm::mat3_cast(q) * v (quaternions as x, y, z, w).
    function rotateByQuaternion(q: number[], v: number[]) {
        const x = q[0];
        const y = q[1];
        const z = q[2];
        const w = q[3];
        return [
            (1.0 - 2.0 * (y * y + z * z)) * v[0] + 2.0 * (x * y - w * z) * v[1] + 2.0 * (x * z + w * y) * v[2],
            2.0 * (x * y + w * z) * v[0] + (1.0 - 2.0 * (x * x + z * z)) * v[1] + 2.0 * (y * z - w * x) * v[2],
            2.0 * (x * z - w * y) * v[0] + 2.0 * (y * z + w * x) * v[1] + (1.0 - 2.0 * (x * x + y * y)) * v[2],
        ];
    }

    // A frame in flight's own data: its slice of the scene constants and
    // the scene pass's descriptor sets (one per base color texture, with that slice).
    class QueuedFrame {
        constructor(public sceneView: NriDescriptor | null, public sceneSets: NriDescriptorSet[]) {
        }
    }

    // A texture and its views: a color (or depth) attachment and a shader resource.
    class Target {
        constructor(public texture: NriTexture, public attachment: NriDescriptor, public view: NriDescriptor) {
        }
    }

    // Port of Vulkan-Samples' msaa to NRI: the Space Module scene forward shaded, with
    // multisampling or not, into the swap chain; or into a texture that a second render pass
    // reads, with the scene's depth, for an outline post-processing effect.
    //
    // NRI's render passes don't resolve, and its CmdResolveTexture averages sRGB textures' encoded
    // values on Vulkan: the multisampled color is resolved by shaders/nri_msaa_resolve.hlsl,
    // whether the sample's setting is "on writeback" (Vulkan's render pass resolve, as the Donut
    // example offers it on Vulkan) or "separate". With post-processing, the multisampled depth is
    // read multisampled (its sample 0, the Donut example's way on D3D, and the same values as
    // Vulkan's default SampleZero depth resolve), or, for Vulkan's Min, Max and Average depth
    // resolve modes (offered where the Donut example offers them: Vulkan), resolved by
    // nri_msaa_resolve.hlsl into an R32_FLOAT texture.
    class Msaa {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        // The swap chain's size: the window's when it was (re)created.
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views'.
        private swapChainFormat: NriFormat = 0;
        private swapChainViewFormat: NriFormat = 0;

        // The sample's settings, from its UI and options.
        sampleCount: int = 1;
        postprocessing: boolean = false;
        colorResolveMethod: int = MsaaResolve.OnWriteback;
        resolveDepthOnWriteback: boolean = true;
        depthResolveMode: int = RESOLVE_NONE;
        // What the device has (as the Donut example asks it): the sample counts (bits), render pass
        // resolves (Vulkan's, as NVRHI runs it), and depth resolve modes (bits 1 << mode).
        private supportedSampleCounts: int = 1;
        private renderPassResolve: boolean = false;
        private depthResolveModes: int = 0;
        // The options: -samples, -post, -separate, -nodepthresolve, -depthresolve.
        requestedSamples: int = 0;
        requestedPostprocessing: boolean = false;
        requestedSeparate: boolean = false;
        requestedNoDepthResolve: boolean = false;
        requestedDepthResolveMode: int = RESOLVE_NONE;

        // The targets, for the settings they were made for (builtSampleCount 0: none yet): the
        // depth (multisampled with MSAA, read by shaders), the multisampled color (with MSAA), the
        // single-sampled color that the post-processing reads (with it), and the resolved depth
        // (for a Min, Max or Average depth resolve: builtDepthResolveMode).
        private builtSampleCount: int = 0;
        private builtPostprocessing: boolean = false;
        private builtDepthResolveMode: int = RESOLVE_NONE;
        private depth: Target | null = null;
        private msColor: Target | null = null;
        private resolvedColor: Target | null = null;
        private resolvedDepth: Target | null = null;

        // The scene pass: its layout (the scene constants b0, the base color texture t0 and its
        // sampler s0, the node transform as root constants b1) and pipelines (by sample count *
        // VARIANT_COUNT + variant, made when first asked for).
        private sceneLayout: NriPipelineLayout | null = null;
        private scenePipelineKeys: int[] = [];
        private scenePipelines: NriPipeline[] = [];
        // The color resolve (the multisampled color at t0) and the depth resolve (the multisampled
        // depth at t1): layouts, pipelines (the depth's by mode: Average, Min, Max) and sets.
        private resolveLayout: NriPipelineLayout | null = null;
        private resolvePipeline: NriPipeline | null = null;
        private resolveSet: NriDescriptorSet | null = null;
        private depthResolveLayout: NriPipelineLayout | null = null;
        private depthResolveModeOfPipeline: int[] = [];
        private depthResolvePipelines: NriPipeline[] = [];
        private depthResolveSet: NriDescriptorSet | null = null;
        // The post-processing: its layout (its constants b0, the color t0 and the depth t1, the
        // sampler s0), the outline effect reading single-sampled and multisampled depth, and its set.
        private postLayout: NriPipelineLayout | null = null;
        private postPipeline: NriPipeline | null = null;
        private postMSPipeline: NriPipeline | null = null;
        private postSet: NriDescriptorSet | null = null;

        private sceneBuffer: NriBuffer | null = null;
        private postBuffer: NriBuffer | null = null;
        private postView: NriDescriptor | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private linearWrap: NriDescriptor | null = null;
        private linearClamp: NriDescriptor | null = null;
        private vertexBuffer: NriBuffer | null = null;
        private indexBuffer: NriBuffer | null = null;
        // The scene's base color textures.
        private textures: NriTexture[] = [];
        private textureViews: NriDescriptor[] = [];
        private shaders: string = "";
        private resolveShaders: string = "";

        // The draws, a node's primitive each: index range and base vertex, base color texture,
        // alpha blending, front faces flipped (a node scaled by a negative factor), node transform
        // (MODEL_FLOATS each, from models), and world bounds center (3 each), in the framework's
        // order: by mesh, node, primitive.
        private drawFirstIndex: int[] = [];
        private drawIndexCount: int[] = [];
        private drawBaseVertex: int[] = [];
        private drawTexture: int[] = [];
        private drawBlend: boolean[] = [];
        private drawFlipped: boolean[] = [];
        private drawCenters: number[] = [];
        private models: f32[] = [];
        // The draws in drawing order: opaque ones front to back, then blended ones back to front.
        private order: int[] = [];
        private distances: number[] = [];

        // Donut's FirstPersonCamera, as the Donut example sets it up.
        private camera: DonutFirstPersonCamera = new DonutFirstPersonCamera(CAMERA_MOVE_SPEED, CAMERA_ROTATE_SPEED);

        // Upload buffers.
        private constants: f32[] = [];
        private postConstants: f32[] = [];

        // The overlay; -noUI: none.
        noUI: boolean = false;
        private imgui: boolean = false;

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.constants.push(0.0);
            }
            for (let i = 0; i < POST_FLOATS; i++) {
                this.postConstants.push(0.0);
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

            // Swap chain: rendered through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.swapChainViewFormat;
            this.viewFormat = viewFormat;

            this.querySupport(device, graphicsAPI);
            this.applyOptions();

            // The samplers: Donut's LinearWrap (the scene's) and LinearClamp (the post-processing's).
            const linearWrap = device.createSamplerWithMipFilter(NriFilter.Linear, NriFilter.Linear, NriAddressMode.Repeat, 1);
            const linearClamp = device.createSamplerWithMipFilter(NriFilter.Linear, NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
            this.linearWrap = linearWrap;
            this.linearClamp = linearClamp;
            if (!linearWrap || !linearClamp || !this.loadScene(device)) {
                console.log("Cannot load the scene and its textures: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }

            if (!this.createLayouts(device)) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }
            const sceneLayout = this.sceneLayout;
            const resolveLayout = this.resolveLayout;
            const depthResolveLayout = this.depthResolveLayout;
            const postLayout = this.postLayout;
            if (!sceneLayout || !resolveLayout || !depthResolveLayout || !postLayout) {
                return 0;
            }

            // The shaders, as compiled for the Donut example, and the resolve's; the scene's pipeline
            // is made for the first sample count now (to fail early), the others' when first drawn
            // with.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            this.shaders = `shaders/msaa/${folder}/`;
            this.resolveShaders = `shaders/nri_msaa_resolve/${folder}/nri_msaa_resolve`;
            this.resolvePipeline = this.createFullscreenPipeline(device, resolveLayout, `${this.resolveShaders}_resolve_vs.bin`, "resolve_vs",
                `${this.resolveShaders}_resolve_ps.bin`, "resolve_ps", "", viewFormat);
            this.postPipeline = this.createFullscreenPipeline(device, postLayout, `${this.shaders}msaa_post_post_vs.bin`, "post_vs",
                `${this.shaders}msaa_post_outline_ps.bin`, "outline_ps", "MS_DEPTH=0", viewFormat);
            this.postMSPipeline = this.createFullscreenPipeline(device, postLayout, `${this.shaders}msaa_post_post_vs.bin`, "post_vs",
                `${this.shaders}msaa_post_outline_ps.bin`, "outline_ps", "MS_DEPTH=1", viewFormat);
            if (!this.getScenePipeline(SceneVariant.Opaque, this.sampleCount) || !this.resolvePipeline || !this.postPipeline || !this.postMSPipeline) {
                console.log("Cannot load the msaa shaders");
                return 0;
            }

            // The scene constants, a queued frame's each; the post-processing's, written once (the
            // sample's near_far: (far, near)).
            const sceneBuffer = device.createHostBuffer(queuedFrameNum * CONST_VIEW_SIZE, NriBufferUsage.ConstantBuffer);
            const postBuffer = device.createHostBuffer(POST_VIEW_SIZE, NriBufferUsage.ConstantBuffer);
            this.sceneBuffer = sceneBuffer;
            this.postBuffer = postBuffer;
            if (!sceneBuffer || !postBuffer) {
                console.log("Cannot create the constant buffers");
                return 0;
            }
            this.postConstants[0] = Z_FAR;
            this.postConstants[1] = Z_NEAR;
            postBuffer.write(0, Ref(this.postConstants[0]), POST_FLOATS * 4);
            const postView = postBuffer.createConstantView(0, POST_VIEW_SIZE);
            this.postView = postView;

            // The descriptor sets: per queued frame, the scene's per base color texture; the color
            // resolve's, the depth resolve's and the post-processing's.
            const textureCount = this.textureViews.length;
            const sceneSetNum = queuedFrameNum * textureCount;
            const descriptorPool = device.createDescriptorPool(sceneSetNum + 3, sceneSetNum + 1, sceneSetNum + 1, sceneSetNum + 4, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!descriptorPool || !postView) {
                console.log("Cannot create the descriptor pool");
                return 0;
            }
            this.resolveSet = descriptorPool.allocateDescriptorSet(resolveLayout, 0, 0);
            this.depthResolveSet = descriptorPool.allocateDescriptorSet(depthResolveLayout, 0, 0);
            const postSet = descriptorPool.allocateDescriptorSet(postLayout, 0, 0);
            this.postSet = postSet;
            if (!this.resolveSet || !this.depthResolveSet || !postSet) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }
            postSet.updateDescriptor(0, 0, postView);
            postSet.updateDescriptor(2, 0, linearClamp);
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const sceneView = sceneBuffer.createConstantView(i * CONST_VIEW_SIZE, CONST_VIEW_SIZE);
                const sceneSets: NriDescriptorSet[] = [];
                this.queuedFrames.push(new QueuedFrame(sceneView, sceneSets));
                if (!sceneView) {
                    console.log("Cannot create the constant buffer views");
                    return 0;
                }
                for (let t = 0; t < textureCount; t++) {
                    const sceneSet = descriptorPool.allocateDescriptorSet(sceneLayout, 0, 0);
                    if (!sceneSet) {
                        console.log("Cannot create the descriptor sets");
                        return 0;
                    }
                    sceneSet.updateDescriptor(0, 0, sceneView);
                    sceneSet.updateDescriptor(1, 0, this.textureViews[t]);
                    sceneSet.updateDescriptor(2, 0, linearWrap);
                    sceneSets.push(sceneSet);
                }
            }

            // The scene's camera, as the sample's free camera starts: looking down its node's -z,
            // its up its node's y (the node rolls it a little).
            const forward = rotateByQuaternion(CAMERA_ROTATION, [0.0, 0.0, -1.0]);
            const up = rotateByQuaternion(CAMERA_ROTATION, [0.0, 1.0, 0.0]);
            const p = CAMERA_POSITION;
            this.camera.lookAtWithUp(p[0], p[1], p[2], p[0] + forward[0], p[1] + forward[1], p[2] + forward[2], up[0], up[1], up[2]);

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

        // The sample's prepare_supported_sample_count_list and prepare_depth_resolve_mode_list: what
        // the device has, as the Donut example sees it (render pass resolves on Vulkan only), and
        // the defaults (the first supported in order of preference).
        querySupport(device: NriDevice, graphicsAPI: NriGraphicsAPI) {
            this.supportedSampleCounts = device.getSupportedSampleCounts(this.viewFormat, DEPTH_FORMAT);
            this.renderPassResolve = graphicsAPI == NriGraphicsAPI.VK;
            this.depthResolveModes = device.getDepthResolveModes();
            this.sampleCount = 1;
            for (let i = 0; i < SAMPLE_COUNTS.length; i++) {
                if ((this.supportedSampleCounts & SAMPLE_COUNTS[i]) != 0) {
                    this.sampleCount = SAMPLE_COUNTS[i];
                    break;
                }
            }
            this.depthResolveMode = RESOLVE_NONE;
            for (const resolveMode of DEPTH_RESOLVE_MODES) {
                if ((this.depthResolveModes & (1 << resolveMode)) != 0) {
                    this.depthResolveMode = resolveMode;
                    break;
                }
            }
            if (!this.renderPassResolve) {
                this.colorResolveMethod = MsaaResolve.Separate;
            }
        }

        // The options, over the defaults: as the Donut example applies them.
        applyOptions() {
            if (this.requestedSamples > 0) {
                if ((this.supportedSampleCounts & this.requestedSamples) != 0) {
                    this.sampleCount = this.requestedSamples;
                } else {
                    console.log(`${this.requestedSamples} samples per pixel aren't supported: ${sampleCountName(this.sampleCount)}`);
                }
            }
            this.postprocessing = this.requestedPostprocessing;
            if (this.requestedSeparate) {
                this.colorResolveMethod = MsaaResolve.Separate;
            }
            if (this.requestedNoDepthResolve) {
                this.resolveDepthOnWriteback = false;
            }
            const mode = this.requestedDepthResolveMode;
            if (mode != RESOLVE_NONE && (this.depthResolveModes & (1 << mode)) != 0) {
                this.depthResolveMode = mode;
            }
        }

        // The layouts: the scene's, the color resolve's, the depth resolve's and the post-processing's;
        // false on failure.
        createLayouts(device: NriDevice): boolean {
            const sceneDesc = NriPipelineLayoutDesc.create();
            sceneDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            sceneDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            sceneDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            sceneDesc.addRootConstants(1, MODEL_SIZE, NriStage.VertexPixel);
            this.sceneLayout = device.createPipelineLayoutFromDesc(sceneDesc);
            sceneDesc.destroy();

            const resolveDesc = NriPipelineLayoutDesc.create();
            resolveDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            this.resolveLayout = device.createPipelineLayoutFromDesc(resolveDesc);
            resolveDesc.destroy();

            const depthResolveDesc = NriPipelineLayoutDesc.create();
            depthResolveDesc.addRange(0, 1, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            this.depthResolveLayout = device.createPipelineLayoutFromDesc(depthResolveDesc);
            depthResolveDesc.destroy();

            const postDesc = NriPipelineLayoutDesc.create();
            postDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Pixel, NriRangeFlags.None);
            postDesc.addRange(0, 0, 2, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            postDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            this.postLayout = device.createPipelineLayoutFromDesc(postDesc);
            postDesc.destroy();
            return this.layoutsCreated();
        }

        layoutsCreated(): boolean {
            if (!this.sceneLayout || !this.resolveLayout || !this.depthResolveLayout) {
                return false;
            }
            return this.postLayout ? true : false;
        }

        // A full screen triangle's pipeline (no vertices, no depth) drawing into format; the pixel
        // shader a permutation of its blob when permutation isn't empty. Null on failure.
        createFullscreenPipeline(device: NriDevice, layout: NriPipelineLayout, vsPath: string, vsEntry: string, psPath: string,
            psEntry: string, permutation: string, format: NriFormat): NriPipeline | null {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, vsPath, vsEntry) != 0;
            if (loaded) {
                loaded = permutation == ""
                    ? desc.addShader(NriShaderStage.Pixel, psPath, psEntry) != 0
                    : desc.addShaderPermutation(NriShaderStage.Pixel, psPath, psEntry, permutation) != 0;
            }
            desc.setColor(format, NriColorWrite.RGBA);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        // The depth resolve's pipeline for a mode (Average, Min or Max), made when first asked for;
        // null on failure.
        getDepthResolvePipeline(mode: int): NriPipeline | null {
            for (let i = 0; i < this.depthResolveModeOfPipeline.length; i++) {
                if (this.depthResolveModeOfPipeline[i] == mode) {
                    return this.depthResolvePipelines[i];
                }
            }
            const device = this.device;
            const layout = this.depthResolveLayout;
            if (!device || !layout) {
                return null;
            }
            const entry = mode == RESOLVE_MIN ? "resolve_depth_min_ps" : mode == RESOLVE_MAX ? "resolve_depth_max_ps" : "resolve_depth_average_ps";
            const pipeline = this.createFullscreenPipeline(device, layout, `${this.resolveShaders}_resolve_vs.bin`, "resolve_vs",
                `${this.resolveShaders}_${entry}.bin`, entry, "", NriFormat.R32_SFLOAT);
            if (pipeline) {
                this.depthResolveModeOfPipeline.push(mode);
                this.depthResolvePipelines.push(pipeline);
            }
            return pipeline;
        }

        // The framework's geometry pipeline state for a variant and sample count, made when first
        // asked for: the scene's vertices; reversed depth (greater), tested and written; back faces
        // culled, counter-clockwise front faces (clockwise for the opaque draws of flipped nodes);
        // blending for the materials in blend mode (Donut's AlphaBlend). Null on failure.
        getScenePipeline(variant: int, sampleCount: int): NriPipeline | null {
            const key = sampleCount * VARIANT_COUNT + variant;
            for (let i = 0; i < this.scenePipelineKeys.length; i++) {
                if (this.scenePipelineKeys[i] == key) {
                    return this.scenePipelines[i];
                }
            }
            const device = this.device;
            const layout = this.sceneLayout;
            if (!device || !layout) {
                return null;
            }
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${this.shaders}msaa_scene_vs.bin`, "scene_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${this.shaders}msaa_scene_ps.bin`, "scene_ps") != 0;
            }
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            desc.addVertexAttribute("NORMAL", NriFormat.RGB32_SFLOAT, NORMAL_OFFSET);
            desc.addVertexAttribute("TEXCOORD", NriFormat.RG32_SFLOAT, TEXCOORD_OFFSET);
            desc.setCullMode(NriCullMode.Back);
            desc.setFrontCounterClockwise(variant == SceneVariant.OpaqueFlipped ? 0 : 1);
            desc.setColor(this.viewFormat, NriColorWrite.RGBA);
            if (variant == SceneVariant.Blend) {
                desc.setBlend(NriBlendFactor.SrcAlpha, NriBlendFactor.OneMinusSrcAlpha, NriBlendOp.Add,
                    NriBlendFactor.OneMinusSrcAlpha, NriBlendFactor.Zero, NriBlendOp.Add);
            }
            desc.setDepth(DEPTH_FORMAT, NriCompareOp.Greater, 1, 0);
            desc.setSampleCount(sampleCount);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            if (pipeline) {
                this.scenePipelineKeys.push(key);
                this.scenePipelines.push(pipeline);
            }
            return pipeline;
        }

        // The depth resolve the settings ask for by a shader (Average, Min or Max: Vulkan's render
        // pass depth resolve with post-processing); RESOLVE_NONE when the post-processing reads the
        // multisampled depth (its sample 0: also SampleZero's values) or there's no MSAA.
        shaderDepthResolveMode(): int {
            if (this.sampleCount <= 1 || !this.postprocessing || !this.resolveDepthOnWriteback || this.depthResolveModes == 0) {
                return RESOLVE_NONE;
            }
            const mode = this.depthResolveMode;
            return mode == RESOLVE_SAMPLE_ZERO ? RESOLVE_NONE : mode;
        }

        targetsAreCurrent() {
            return this.builtSampleCount == this.sampleCount && this.builtPostprocessing == this.postprocessing
                && this.builtDepthResolveMode == this.shaderDepthResolveMode();
        }

        // The sample's update_pipelines (on a change of settings) and create_render_target: the
        // targets for the settings, and the resolves' and post-processing's sets reading them; the
        // GPU must not be using the old ones.
        createTargets() {
            const device = this.device;
            if (!device) {
                return;
            }
            device.waitIdle();
            this.destroyTargets();
            const sampleCount = this.sampleCount;
            const msaa = sampleCount > 1;
            const depthTexture = device.createSampledMultisampledDepthTexture(this.queue, this.width, this.height, DEPTH_FORMAT, sampleCount);
            if (depthTexture) {
                this.depth = new Target(depthTexture, depthTexture.createDepthAttachmentView(DEPTH_FORMAT),
                    depthTexture.createView(DEPTH_FORMAT));
            }
            if (msaa) {
                const msColor = device.createMultisampledRenderTarget(this.queue, this.width, this.height, this.viewFormat, sampleCount);
                if (msColor) {
                    this.msColor = new Target(msColor, msColor.createColorAttachmentView(this.viewFormat),
                        msColor.createView(this.viewFormat));
                }
            }
            if (this.postprocessing) {
                const resolvedColor = device.createRenderTargetTexture(this.queue, this.width, this.height, this.viewFormat);
                if (resolvedColor) {
                    this.resolvedColor = new Target(resolvedColor, resolvedColor.createColorAttachmentView(this.viewFormat),
                        resolvedColor.createView(this.viewFormat));
                }
            }
            const depthResolveMode = this.shaderDepthResolveMode();
            if (depthResolveMode != RESOLVE_NONE) {
                const resolvedDepth = device.createRenderTargetTexture(this.queue, this.width, this.height, NriFormat.R32_SFLOAT);
                if (resolvedDepth) {
                    this.resolvedDepth = new Target(resolvedDepth, resolvedDepth.createColorAttachmentView(NriFormat.R32_SFLOAT),
                        resolvedDepth.createView(NriFormat.R32_SFLOAT));
                }
            }
            this.updateTargetSets();
            this.builtSampleCount = sampleCount;
            this.builtPostprocessing = this.postprocessing;
            this.builtDepthResolveMode = depthResolveMode;
        }

        // The resolves' and the post-processing's sets: the multisampled color and depth they
        // resolve; the color and depth (the resolved one, else the scene's) it reads.
        updateTargetSets() {
            const depth = this.depth;
            const resolveSet = this.resolveSet;
            const depthResolveSet = this.depthResolveSet;
            const postSet = this.postSet;
            if (!depth || !resolveSet || !depthResolveSet || !postSet) {
                return;
            }
            const msColor = this.msColor;
            if (msColor) {
                resolveSet.updateDescriptor(0, 0, msColor.view);
            }
            depthResolveSet.updateDescriptor(0, 0, depth.view);
            const resolvedColor = this.resolvedColor;
            if (resolvedColor) {
                postSet.updateDescriptor(1, 0, resolvedColor.view);
                const resolvedDepth = this.resolvedDepth;
                postSet.updateDescriptor(1, 1, resolvedDepth ? resolvedDepth.view : depth.view);
            }
        }

        destroyTarget(target: Target | null) {
            if (target) {
                target.attachment.destroy();
                target.view.destroy();
                target.texture.destroy();
            }
        }

        destroyTargets() {
            this.destroyTarget(this.depth);
            this.destroyTarget(this.msColor);
            this.destroyTarget(this.resolvedColor);
            this.destroyTarget(this.resolvedDepth);
            this.depth = null;
            this.msColor = null;
            this.resolvedColor = null;
            this.resolvedDepth = null;
            this.builtSampleCount = 0;
        }

        // Waits for the frame that last used this frame's command allocator (and its constants).
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The sample's options window.
        buildUI() {
            this.sample.imguiNewFrame();
            const msaaEnabled = this.sampleCount > 1;
            NriImgui.setNextWindowPos(10.0, 10.0);
            NriImgui.begin("Options", 1);

            let countNames = "";
            const counts: int[] = [];
            let current = 0;
            for (const count of SAMPLE_COUNTS) {
                if ((this.supportedSampleCounts & count) == 0) {
                    continue;
                }
                if (count == this.sampleCount) {
                    current = counts.length;
                }
                countNames += (counts.length > 0 ? "|" : "") + sampleCountName(count);
                counts.push(count);
            }
            if (counts.length > 0) {
                this.sampleCount = counts[NriImgui.combo("##sample_count", current, countNames)];
            }
            NriImgui.sameLine();
            this.postprocessing = NriImgui.checkbox("Post-processing (2 renderpasses)", this.postprocessing ? 1 : 0) != 0;

            NriImgui.text("Resolve color: ");
            NriImgui.sameLine();
            if (!msaaEnabled) {
                NriImgui.text("n/a");
            } else if (this.renderPassResolve) {
                if (NriImgui.radioButton("On writeback", this.colorResolveMethod == MsaaResolve.OnWriteback ? 1 : 0) != 0) {
                    this.colorResolveMethod = MsaaResolve.OnWriteback;
                }
                NriImgui.sameLine();
                if (NriImgui.radioButton("Separate", this.colorResolveMethod == MsaaResolve.Separate ? 1 : 0) != 0) {
                    this.colorResolveMethod = MsaaResolve.Separate;
                }
            } else {
                // No render pass resolves (D3D, as NVRHI runs it).
                NriImgui.text("Separate");
            }

            NriImgui.text("Resolve depth: ");
            NriImgui.sameLine();
            if (!msaaEnabled || !this.postprocessing) {
                NriImgui.text("n/a");
            } else if (this.depthResolveModes != 0) {
                this.resolveDepthOnWriteback = NriImgui.checkbox("##resolve_depth", this.resolveDepthOnWriteback ? 1 : 0) != 0;
                NriImgui.sameLine();
                NriImgui.text("On writeback");
                NriImgui.sameLine();
                NriImgui.pushItemWidth(120.0);
                let modeNames = "";
                const modes: int[] = [];
                let currentMode = 0;
                for (const mode of DEPTH_RESOLVE_MODES) {
                    if ((this.depthResolveModes & (1 << mode)) == 0) {
                        continue;
                    }
                    if (mode == this.depthResolveMode) {
                        currentMode = modes.length;
                    }
                    modeNames += (modes.length > 0 ? "|" : "") + resolveModeName(mode);
                    modes.push(mode);
                }
                this.depthResolveMode = modes[NriImgui.combo("##resolve_mode", currentMode, modeNames)];
                NriImgui.popItemWidth();
            } else {
                NriImgui.text("Not supported");
            }
            NriImgui.end();
            this.sample.imguiRender();
        }

        // The scene uniforms: the camera's view-projection in Donut's clip space, and the light (its
        // direction, the node's rotation of (0, 0, -1)), into this frame's slice; the camera's
        // position, for the draws' order.
        writeConstants(queuedFrameIndex: int) {
            const sceneBuffer = this.sceneBuffer;
            if (!sceneBuffer) {
                return;
            }
            // Donut's camera, in Donut's view space (z forward), into the sample's (-z forward).
            const viewMatrix = this.camera.worldToView();
            const view: number[] = [];
            for (let i = 0; i < 16; i++) {
                view.push(i % 4 == 2 ? -viewMatrix[i] : viewMatrix[i]);
            }
            const viewProj = toDonutClip(multiply(vulkanStyleProjection(reversedPerspective(CAMERA_FOV, this.width / this.height, Z_NEAR, Z_FAR)),
                view));
            const c = this.constants;
            for (let i = 0; i < 16; i++) {
                c[CONST_VIEW_PROJ + i] = viewProj[i];
            }
            for (let i = 0; i < 4; i++) {
                c[CONST_LIGHT_COLOR + i] = LIGHT_COLOR[i];
            }
            const direction = rotateByQuaternion(LIGHT_ROTATION, [0.0, 0.0, -1.0]);
            for (let i = 0; i < 3; i++) {
                c[CONST_LIGHT_DIRECTION + i] = direction[i];
            }
            c[CONST_LIGHT_DIRECTION + 3] = 0.0;
            sceneBuffer.write(queuedFrameIndex * CONST_VIEW_SIZE, Ref(c[0]), CONST_FLOATS * 4);

            // The camera's position: -R^T t of its view [R t].
            const position: number[] = [0.0, 0.0, 0.0];
            for (let column = 0; column < 3; column++) {
                for (let row = 0; row < 3; row++) {
                    position[column] -= viewMatrix[column * 4 + row] * viewMatrix[12 + row];
                }
            }
            this.sortDraws(position[0], position[1], position[2]);
        }

        // The framework's GeometrySubpass order, from a camera at (x, y, z): opaque draws front to
        // back, then the blended ones back to front, by the distance to their node's bounds;
        // stable, as its multimap.
        sortDraws(x: number, y: number, z: number) {
            const count = this.drawIndexCount.length;
            for (let d = 0; d < count; d++) {
                const dx = this.drawCenters[d * 3] - x;
                const dy = this.drawCenters[d * 3 + 1] - y;
                const dz = this.drawCenters[d * 3 + 2] - z;
                this.distances[d] = Math.sqrt(dx * dx + dy * dy + dz * dz);
            }
            let n = 0;
            for (let pass = 0; pass < 2; pass++) {
                const first = n;
                for (let d = 0; d < count; d++) {
                    if (this.drawBlend[d] != (pass == 1)) {
                        continue;
                    }
                    // Insertion sort: nearest first for opaque draws, farthest first for blended ones.
                    let i = n;
                    while (i > first) {
                        const previous = this.distances[this.order[i - 1]];
                        const after = pass == 0 ? previous > this.distances[d] : previous < this.distances[d];
                        if (!after) {
                            break;
                        }
                        this.order[i] = this.order[i - 1];
                        i--;
                    }
                    this.order[i] = d;
                    n++;
                }
            }
        }

        // The draws in their order, each with its variant's pipeline (for the targets' sample count),
        // its texture's set and its node's transform (between NriCommandBuffer.beginRenderingWithDepth and
        // NriCommandBuffer.endRendering).
        recordDraws(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const layout = this.sceneLayout;
            const vertexBuffer = this.vertexBuffer;
            const indexBuffer = this.indexBuffer;
            if (!layout || !vertexBuffer || !indexBuffer) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(layout);
            commandBuffer.setIndexBuffer(indexBuffer, 0, NriIndexType.UInt32);
            commandBuffer.setVertexBuffer(0, vertexBuffer, 0, VERTEX_SIZE);
            // The current pipeline's variant and texture (-1 before the first draw).
            let currentVariant = -1;
            let currentTexture = -1;
            for (const d of this.order) {
                const variant = this.drawBlend[d] ? SceneVariant.Blend : this.drawFlipped[d] ? SceneVariant.OpaqueFlipped : SceneVariant.Opaque;
                if (variant != currentVariant) {
                    const pipeline = this.getScenePipeline(variant, this.builtSampleCount);
                    if (!pipeline) {
                        continue;
                    }
                    commandBuffer.setPipeline(pipeline);
                    currentVariant = variant;
                }
                const texture = this.drawTexture[d];
                if (texture != currentTexture) {
                    commandBuffer.setDescriptorSet(0, queuedFrame.sceneSets[texture]);
                    currentTexture = texture;
                }
                commandBuffer.setRootConstants(0, Ref(this.models[d * MODEL_FLOATS]), MODEL_SIZE);
                commandBuffer.drawIndexed(this.drawIndexCount[d], 1, this.drawFirstIndex[d], this.drawBaseVertex[d], 0);
            }
        }

        // A full screen triangle of a pipeline with a set into an attachment (cleared first: D3D12
        // wants render targets initialized before draws write them), between barriers the caller
        // makes.
        recordFullscreen(commandBuffer: NriCommandBuffer, attachment: NriDescriptor, clear: boolean,
            layout: NriPipelineLayout, pipeline: NriPipeline, descriptorSet: NriDescriptorSet) {
            commandBuffer.beginRendering(attachment);
            if (clear) {
                commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(layout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setDescriptorSet(0, descriptorSet);
            commandBuffer.draw(3, 1, 0, 0);
            commandBuffer.endRendering();
        }

        // The sample's passes into the swap chain texture (left as a color attachment): the scene
        // into the multisampled color, the post-processing's color or the swap chain texture (cleared
        // to black, depth to 0); the multisampled color resolved; the post-processing over the
        // resolved color with the depth.
        recordScene(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame, index: int) {
            const depth = this.depth;
            if (!depth) {
                return;
            }
            const msColor = this.msColor;
            const resolvedColor = this.resolvedColor;
            const post = this.builtPostprocessing;
            commandBuffer.textureBarrier(this.swapChain.texture(index), NriTextureState.Undefined, NriTextureState.ColorAttachment);

            // The scene pass.
            let sceneAttachment = this.swapChain.colorAttachment(index);
            if (msColor) {
                sceneAttachment = msColor.attachment;
            } else if (resolvedColor) {
                sceneAttachment = resolvedColor.attachment;
                commandBuffer.textureBarrier(resolvedColor.texture, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            }
            commandBuffer.textureBarrier(depth.texture, NriTextureState.ShaderResource, NriTextureState.DepthAttachment);
            commandBuffer.beginRenderingWithDepth(sceneAttachment, depth.attachment);
            commandBuffer.clearColor(0.0, 0.0, 0.0, 1.0);
            commandBuffer.clearDepth(0.0);
            this.recordDraws(commandBuffer, queuedFrame);
            commandBuffer.endRendering();
            commandBuffer.textureBarrier(depth.texture, NriTextureState.DepthAttachment, NriTextureState.ShaderResource);

            this.recordColorResolve(commandBuffer, index);
            if (!post || !resolvedColor) {
                return;
            }
            commandBuffer.textureBarrier(resolvedColor.texture, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
            this.recordDepthResolve(commandBuffer);
            this.recordPost(commandBuffer, index);
        }

        // The multisampled color resolved (averaged in linear space: read and written through sRGB
        // views) into the post-processing's color or the swap chain texture, on writeback or
        // separately alike.
        recordColorResolve(commandBuffer: NriCommandBuffer, index: int) {
            const msColor = this.msColor;
            const resolveLayout = this.resolveLayout;
            const resolvePipeline = this.resolvePipeline;
            const resolveSet = this.resolveSet;
            if (!msColor || !resolveLayout || !resolvePipeline || !resolveSet) {
                return;
            }
            commandBuffer.textureBarrier(msColor.texture, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
            const resolvedColor = this.resolvedColor;
            if (resolvedColor) {
                commandBuffer.textureBarrier(resolvedColor.texture, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
                this.recordFullscreen(commandBuffer, resolvedColor.attachment, true, resolveLayout, resolvePipeline, resolveSet);
            } else {
                this.recordFullscreen(commandBuffer, this.swapChain.colorAttachment(index), false, resolveLayout, resolvePipeline, resolveSet);
            }
            commandBuffer.textureBarrier(msColor.texture, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
        }

        // The multisampled depth resolved by a shader (a Min, Max or Average depth resolve).
        recordDepthResolve(commandBuffer: NriCommandBuffer) {
            const resolvedDepth = this.resolvedDepth;
            const layout = this.depthResolveLayout;
            const descriptorSet = this.depthResolveSet;
            if (!resolvedDepth || !layout || !descriptorSet) {
                return;
            }
            const pipeline = this.getDepthResolvePipeline(this.builtDepthResolveMode);
            if (!pipeline) {
                return;
            }
            commandBuffer.textureBarrier(resolvedDepth.texture, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            this.recordFullscreen(commandBuffer, resolvedDepth.attachment, true, layout, pipeline, descriptorSet);
            commandBuffer.textureBarrier(resolvedDepth.texture, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
        }

        // The second render pass: the outline effect over the resolved color into the swap chain
        // texture (the UI comes after, in a pass of its own), reading the multisampled depth unless
        // a resolved one is there or there's no MSAA.
        recordPost(commandBuffer: NriCommandBuffer, index: int) {
            const layout = this.postLayout;
            const descriptorSet = this.postSet;
            const multisampledDepth = this.resolvedDepth ? false : this.builtSampleCount > 1;
            const pipeline = multisampledDepth ? this.postMSPipeline : this.postPipeline;
            if (!layout || !descriptorSet || !pipeline) {
                return;
            }
            this.recordFullscreen(commandBuffer, this.swapChain.colorAttachment(index), false, layout, pipeline, descriptorSet);
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain made again at its size, once
        // the GPU is done with the old one; the targets dropped, so renderFrame makes them again at that
        // size (createTargets, which also points the resolves' and post-processing's sets at them).
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
            this.destroyTargets();
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            const mouseFree = !this.imgui || NriImgui.wantsMouse() == 0;
            this.camera.animate(this.sample, this.test ? Math.fround(1.0 / 60.0) : this.sample.getFrameTime(), mouseFree);
            if (!this.targetsAreCurrent()) {
                this.createTargets();
            }
            this.writeConstants(queuedFrameIndex);

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const commandBuffer = this.frames.commandBuffer(frameIndex);
                const descriptorPool = this.descriptorPool;

                // Record: the sample's passes, then the overlay over them (a pass of its own: without
                // depth).
                commandBuffer.begin();
                if (this.imgui) {
                    this.sample.copyImguiData(commandBuffer);
                }
                if (descriptorPool) {
                    commandBuffer.setDescriptorPool(descriptorPool);
                }
                this.recordScene(commandBuffer, queuedFrame, index);
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

            // Signaled after the present, as NRISamples do
            this.frames.signal(frameIndex);
        }

        // The scene's base color textures and its draws: every node's primitives, their vertices and
        // indices in one vertex and one index buffer; false on failure.
        loadScene(device: NriDevice): boolean {
            const scene = NriGltfModel.load(SCENE_PATH);
            if (!scene) {
                return false;
            }
            const loaded = this.loadSceneFrom(device, scene);
            scene.destroy();
            return loaded;
        }

        loadSceneFrom(device: NriDevice, scene: NriGltfModel): boolean {
            const primitiveCount = scene.getPrimitiveCount();

            // The primitives' textures (by image URI) and vertices.
            const imageNames: string[] = [];
            const primitiveTexture: int[] = [];
            const primitiveFirstIndex: int[] = [];
            const primitiveBaseVertex: int[] = [];
            const vertices: f32[] = [];
            const indices: int[] = [];
            // Per mesh: its bounds (min x, y, z, max x, y, z) and first primitive.
            const meshBounds: number[] = [];
            const meshFirstPrimitive: int[] = [];
            for (let p = 0; p < primitiveCount; p++) {
                const image = scene.getBaseColorImage(p);
                let texture = -1;
                for (let t = 0; t < imageNames.length; t++) {
                    if (imageNames[t] == image) {
                        texture = t;
                    }
                }
                if (texture < 0) {
                    texture = imageNames.length;
                    imageNames.push(image);
                }
                primitiveTexture.push(texture);

                const mesh = scene.getPrimitiveMesh(p);
                if (mesh == meshFirstPrimitive.length) {
                    meshFirstPrimitive.push(p);
                    for (let k = 0; k < 3; k++) {
                        meshBounds.push(HUGE);
                    }
                    for (let k = 0; k < 3; k++) {
                        meshBounds.push(-HUGE);
                    }
                }

                const vertexCount = scene.getVertexCount(p);
                const indexCount = scene.getIndexCount(p);
                const primitiveVertices: f32[] = [];
                for (let i = 0; i < vertexCount * VERTEX_FLOATS; i++) {
                    primitiveVertices.push(0.0);
                }
                const primitiveIndices: int[] = [];
                for (let i = 0; i < indexCount; i++) {
                    primitiveIndices.push(0);
                }
                scene.copyVertices(p, Ref(primitiveVertices[0]));
                scene.copyIndices(p, Ref(primitiveIndices[0]));

                primitiveBaseVertex.push(vertices.length / VERTEX_FLOATS);
                primitiveFirstIndex.push(indices.length);
                for (let v = 0; v < vertexCount * VERTEX_FLOATS; v++) {
                    vertices.push(primitiveVertices[v]);
                }
                for (let i = 0; i < indexCount; i++) {
                    indices.push(primitiveIndices[i]);
                }
                for (let v = 0; v < vertexCount * VERTEX_FLOATS; v += VERTEX_FLOATS) {
                    for (let k = 0; k < 3; k++) {
                        meshBounds[mesh * 6 + k] = Math.min(meshBounds[mesh * 6 + k], primitiveVertices[v + k]);
                        meshBounds[mesh * 6 + 3 + k] = Math.max(meshBounds[mesh * 6 + 3 + k], primitiveVertices[v + k]);
                    }
                }
            }
            meshFirstPrimitive.push(primitiveCount);

            // As the framework loads ASTC textures on GPUs without ASTC: level 0 decoded (to DDS
            // here), sRGB as the Donut example loads them.
            for (const name of imageNames) {
                const dot = name.lastIndexOf(".");
                const path = SCENE_DIR + (dot >= 0 ? name.substring(0, dot) : name) + ".dds";
                const texture = device.loadDdsTexture(this.queue, path, 1);
                if (!texture) {
                    return false;
                }
                this.textures.push(texture);
                this.textureViews.push(texture.createView(texture.getFormat()));
            }
            if (imageNames.length == 0) {
                return false;
            }

            // The draws: by mesh, then node, then primitive, as the framework's meshes list their
            // nodes and submeshes.
            const nodeCount = scene.getNodeCount();
            const transform: f32[] = [];
            for (let i = 0; i < 16; i++) {
                transform.push(0.0);
            }
            for (let mesh = 0; mesh + 1 < meshFirstPrimitive.length; mesh++) {
                for (let node = 0; node < nodeCount; node++) {
                    if (scene.getNodeMesh(node) != mesh) {
                        continue;
                    }
                    scene.copyNodeTransform(node, Ref(transform[0]));
                    // Flipped: scaled by a negative factor, as the framework tells by the node's
                    // scale (the determinant of its world transform here: no parent flips here).
                    const determinant = transform[0] * (transform[5] * transform[10] - transform[9] * transform[6])
                        - transform[4] * (transform[1] * transform[10] - transform[9] * transform[2])
                        + transform[8] * (transform[1] * transform[6] - transform[5] * transform[2]);
                    // The mesh's bounds, transformed (their corners), and their center.
                    const low = [HUGE, HUGE, HUGE];
                    const high = [-HUGE, -HUGE, -HUGE];
                    for (let corner = 0; corner < 8; corner++) {
                        const x = meshBounds[mesh * 6 + ((corner & 1) != 0 ? 3 : 0)];
                        const y = meshBounds[mesh * 6 + 1 + ((corner & 2) != 0 ? 3 : 0)];
                        const z = meshBounds[mesh * 6 + 2 + ((corner & 4) != 0 ? 3 : 0)];
                        for (let k = 0; k < 3; k++) {
                            const value = transform[k] * x + transform[4 + k] * y + transform[8 + k] * z + transform[12 + k];
                            low[k] = Math.min(low[k], value);
                            high[k] = Math.max(high[k], value);
                        }
                    }
                    for (let p = meshFirstPrimitive[mesh]; p < meshFirstPrimitive[mesh + 1]; p++) {
                        this.drawFirstIndex.push(primitiveFirstIndex[p]);
                        this.drawIndexCount.push(scene.getIndexCount(p));
                        this.drawBaseVertex.push(primitiveBaseVertex[p]);
                        this.drawTexture.push(primitiveTexture[p]);
                        // Alpha mode 2: blend.
                        this.drawBlend.push(scene.getPrimitiveAlphaMode(p) == 2);
                        this.drawFlipped.push(determinant < 0.0);
                        for (let k = 0; k < 3; k++) {
                            this.drawCenters.push(0.5 * (low[k] + high[k]));
                        }
                        for (let i = 0; i < 16; i++) {
                            this.models.push(transform[i]);
                        }
                        this.order.push(this.order.length);
                        this.distances.push(0.0);
                    }
                }
            }

            this.vertexBuffer = device.createUploadedBuffer(this.queue, Ref(vertices[0]), vertices.length * 4, NriBufferUsage.VertexBuffer);
            this.indexBuffer = device.createUploadedBufferFromInts(this.queue, Ref(indices[0]), indices.length * 4,
                NriBufferUsage.IndexBuffer);
            return this.buffersCreated();
        }

        buffersCreated(): boolean {
            if (!this.vertexBuffer) {
                return false;
            }
            return this.indexBuffer ? true : false;
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
                for (const pipeline of this.scenePipelines) {
                    pipeline.destroy();
                }
                for (const pipeline of this.depthResolvePipelines) {
                    pipeline.destroy();
                }
                this.destroyPipeline(this.resolvePipeline);
                this.destroyPipeline(this.postPipeline);
                this.destroyPipeline(this.postMSPipeline);
                this.destroyLayout(this.sceneLayout);
                this.destroyLayout(this.resolveLayout);
                this.destroyLayout(this.depthResolveLayout);
                this.destroyLayout(this.postLayout);
                for (const view of this.textureViews) {
                    view.destroy();
                }
                for (const texture of this.textures) {
                    texture.destroy();
                }
                this.destroyTargets();
                this.destroyDescriptor(this.postView);
                this.destroyDescriptor(this.linearWrap);
                this.destroyDescriptor(this.linearClamp);
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.indexBuffer);
                this.destroyBuffer(this.sceneBuffer);
                this.destroyBuffer(this.postBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.frames.destroy();
                this.swapChain.destroy();
                device.destroy();
            }
            this.sample.destroy();
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
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const msaa = new Msaa(sample);
        // -samples <n>: n samples per pixel (1 for no MSAA) instead of the preferred supported count;
        // -post: with the post-processing pass; -separate: the color resolved in a separate pass (the
        // same shader resolve here); -nodepthresolve: the post-processing reads multisampled depth
        // even where the depth would be resolved; -depthresolve zero|average|min|max: the depth
        // resolve mode (where Vulkan's render passes have it); -noUI: no overlay.
        sample.addExampleOptionWithValues("-samples", 1);
        sample.addExampleOption("-post");
        sample.addExampleOption("-separate");
        sample.addExampleOption("-nodepthresolve");
        sample.addExampleOptionWithValues("-depthresolve", 1);
        sample.addExampleOption("-noUI");
        sample.useImgui();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-samples" && i + 1 < argc) {
                i++;
                msaa.requestedSamples = parseInt(Nri.getArg(argc, argv, i));
            } else if (arg == "-post") {
                msaa.requestedPostprocessing = true;
            } else if (arg == "-separate") {
                msaa.requestedSeparate = true;
            } else if (arg == "-nodepthresolve") {
                msaa.requestedNoDepthResolve = true;
            } else if (arg == "-depthresolve" && i + 1 < argc) {
                i++;
                const mode = Nri.getArg(argc, argv, i);
                if (mode == "zero") {
                    msaa.requestedDepthResolveMode = RESOLVE_SAMPLE_ZERO;
                } else if (mode == "average") {
                    msaa.requestedDepthResolveMode = RESOLVE_AVERAGE;
                } else if (mode == "min") {
                    msaa.requestedDepthResolveMode = RESOLVE_MIN;
                } else if (mode == "max") {
                    msaa.requestedDepthResolveMode = RESOLVE_MAX;
                }
            } else if (arg == "-noUI") {
                msaa.noUI = true;
            }
        }
        return msaa.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return MsaaNri.main(argc, argv);
}

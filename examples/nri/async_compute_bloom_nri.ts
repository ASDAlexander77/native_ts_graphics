/// <reference path="../../core/nri/nri_interop.d.ts" />
import { identity, multiply, reversedPerspective, vulkanStyleProjection, toDonutClip } from "../../core/matrix";
import { DonutFirstPersonCamera } from "../../core/donut_first_person_camera";

namespace AsyncComputeBloomNri {
    // async_compute_bloom, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (async_compute_bloom.hlsl's and async_compute_bloom_post.hlsl's),
    // scene (read as Donut's loadGltfModel reads it) and textures, through the NRI calls
    // core/nri/nri_interop.d.ts binds, with NRIFramework's ImGui for the sample's overlay. This
    // example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Async Compute Bloom";

    // The sample's scene (Vulkan-Samples' assets): a glTF file whose base color textures, KTX 2
    // ASTC, are decoded to DDS at build time (see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const SCENE_DIR = "media/async_compute_bloom/bonza/";
    const SCENE_PATH = SCENE_DIR + "Bonza.gltf";

    // Nri_LoadGltfModel's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_FLOATS = 8;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;
    const NORMAL_OFFSET = 12;
    const TEXCOORD_OFFSET = 24;

    // struct SceneConstants { float4x4 viewProj, shadowMatrix; float4 lightColor, lightDirection; },
    // as f32 offsets; the shadow pass's and the forward pass's, each in a constant buffer view of
    // CONST_VIEW_SIZE bytes (D3D12's 256 multiple), a queued frame's each.
    const CONST_VIEW_PROJ = 0;
    const CONST_SHADOW_MATRIX = 16;
    const CONST_LIGHT_COLOR = 32;
    const CONST_LIGHT_DIRECTION = 36;
    const CONST_FLOATS = 40;
    const CONST_VIEW_SIZE = 256;
    // The draws' push constants (root constants at b1): their node's transform.
    const MODEL_FLOATS = 16;
    const MODEL_SIZE = MODEL_FLOATS * 4;
    // struct BlurConstants { uint2 resolution; float2 invResolution, invInputResolution; } (root
    // constants at b0).
    const BLUR_FLOATS = 6;
    const BLUR_SIZE = BLUR_FLOATS * 4;

    // The sample's render targets: 4K HDR color (to make it demanding enough for the mobile GPUs it
    // was tested on), an 8K shadow map, and the bloom's chain of half sizes below the HDR target's
    // (levels 1 to 6).
    const HDR_WIDTH = 3840;
    const HDR_HEIGHT = 2160;
    const SHADOW_RESOLUTION = 8192;
    const BLUR_LEVELS = 6;
    // The bloom's output: the chain's index 1 (level 2, a quarter of the HDR size).
    const BLOOM_INDEX = 1;
    // The compute shaders' 8 x 8 thread groups.
    const BLUR_GROUP_SIZE = 8;

    // The scene's camera node (main_camera): position, and orientation (x, y, z, w) without roll,
    // its perspective's vertical field of view and depth range.
    const CAMERA_POSITION = [-110.107864, 1103.093872, -640.680786];
    const CAMERA_ROTATION = [0.069169, -0.919112, -0.187113, -0.339761];
    const CAMERA_FOV = 1.0;
    const Z_NEAR = 1.0;
    const Z_FAR = 4000.0;
    // The sample's free camera: 50 units per step, times its speed multiplier of 3, per second;
    // Donut's FirstPersonCamera's default rotation speed.
    const CAMERA_MOVE_SPEED = 150.0;
    const CAMERA_ROTATE_SPEED = 0.005;

    // The sample's directional light: its color and intensity, and the shadow camera on its node,
    // an orthographic one "hardcoded to fit to the scene".
    const LIGHT_COLOR = [50.0, 40.0, 30.0, 1.0];
    const SHADOW_LEFT = -2000.0;
    const SHADOW_RIGHT = 3000.0;
    const SHADOW_BOTTOM = -2500.0;
    const SHADOW_TOP = 1500.0;
    const SHADOW_NEAR = -2000.0;
    const SHADOW_FAR = 2000.0;
    // The shadow pass's depth bias: negative, as depth is reversed.
    const SHADOW_DEPTH_BIAS = -1.0;
    const SHADOW_SLOPE_SCALED_DEPTH_BIAS = -2.0;

    // The sample's benchmark mode (-benchmark): simulated at 60 frames per second.
    const BENCHMARK_FRAME_TIME = 1.0 / 60.0;

    // Bounds start out inverted.
    const HUGE = 1.0e30;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // The blur chain's level sizes: the HDR size halved `level` times.
    // Whether moving a texture from state before to after needs a barrier: not between two reads by
    // shaders (pixel and compute: reads after reads need no ordering, and on a D3D12 graphics
    // command list NRI maps both to PIXEL | NON_PIXEL_SHADER_RESOURCE, where a barrier between
    // them is rejected).
    function needsBarrier(before: NriTextureState, after: NriTextureState) {
        if (before == after) {
            return false;
        }
        const beforeRead = before == NriTextureState.ShaderResource || before == NriTextureState.ComputeShaderResource;
        const afterRead = after == NriTextureState.ShaderResource || after == NriTextureState.ComputeShaderResource;
        return !beforeRead || !afterRead;
    }

    function levelWidth(level: int): int {
        return Math.max(1, HDR_WIDTH >> level);
    }

    function levelHeight(level: int): int {
        return Math.max(1, HDR_HEIGHT >> level);
    }

    // --- Math (glm's layout: 4 x 4 matrices by columns, quaternions as x, y, z, w) --------------

    // glm::angleAxis.
    function angleAxis(angle: number, x: number, y: number, z: number) {
        const s = Math.sin(0.5 * angle);
        return [x * s, y * s, z * s, Math.cos(0.5 * angle)];
    }

    // a * b.
    function quatMultiply(a: number[], b: number[]) {
        return [
            a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
            a[3] * b[1] + a[1] * b[3] + a[2] * b[0] - a[0] * b[2],
            a[3] * b[2] + a[2] * b[3] + a[0] * b[1] - a[1] * b[0],
            a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
        ];
    }

    function quatNormalize(q: number[]) {
        const length = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
        return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
    }

    // glm::mat4_cast.
    function quatToMatrix(q: number[]) {
        const x = q[0];
        const y = q[1];
        const z = q[2];
        const w = q[3];
        return [
            1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z),       2.0 * (x * z - w * y),       0.0,
            2.0 * (x * y - w * z),       1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x),       0.0,
            2.0 * (x * z + w * y),       2.0 * (y * z - w * x),       1.0 - 2.0 * (x * x + y * y), 0.0,
            0.0,                         0.0,                         0.0,                         1.0,
        ];
    }

    function transpose(m: number[]) {
        let result: number[] = [];
        for (let column = 0; column < 4; column++) {
            for (let row = 0; row < 4; row++) {
                result.push(m[row * 4 + column]);
            }
        }
        return result;
    }

    // The framework's OrthographicCamera::get_projection, glm::ortho(left, right, bottom, top,
    // far, near) (swapped too).
    function reversedOrtho(left: number, right: number, bottom: number, top: number, zNear: number, zFar: number) {
        const n = zFar;
        const f = zNear;
        return [
            2.0 / (right - left),             0.0,                              0.0,              0.0,
            0.0,                              2.0 / (top - bottom),             0.0,              0.0,
            0.0,                              0.0,                              -1.0 / (f - n),   0.0,
            -(right + left) / (right - left), -(top + bottom) / (top - bottom), -n / (f - n),     1.0,
        ];
    }

    // The pixels of the frame (0xAABBGGRR) whose channels are in the ranges.
    function countInRange(pixels: int[], rMin: int, rMax: int, gMin: int, gMax: int, bMin: int, bMax: int) {
        let count = 0;
        for (let i = 0; i < pixels.length; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r >= rMin && r <= rMax && g >= gMin && g <= gMax && b >= bMin && b <= bMax) {
                count++;
            }
        }
        return count;
    }

    // count of total as a percentage in [min, max]: "" if it is, else why not.
    function share(count: int, total: int, min: number, max: number, what: string) {
        const percent = 100.0 * count / total;
        console.log(`${what}: ${percent}% (${count} of ${total} pixels)`);
        if (percent < min || percent > max) {
            return `${what}: ${percent}% of the pixels, not ${min}% to ${max}%`;
        }
        return "";
    }

    // -test: checks the last frame, read back, as the Donut example does: the red dragon (about 3%
    // of the frame), and the bloom's near white glow around the lights (about 5.5%).
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const total = width * height;
        const red = share(countInRange(pixels, 151, 255, 0, 99, 0, 99), total, 1.5, 6.0, "Red");
        if (red != "") {
            return red;
        }
        return share(countInRange(pixels, 231, 255, 231, 255, 231, 255), total, 2.5, 11.0, "Near white");
    }

    // What a frame in flight records into: the graphics queue's command buffers (the scene's, and
    // the composite's after the compute queue's bloom; the scene's alone holds the whole frame
    // without async queues), the compute queue's; its constant buffer views, and its descriptor sets:
    // the shadow pass's, and the forward pass's per base color texture.
    class QueuedFrame {
        forwardSets: NriDescriptorSetHandle[] = [];

        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public compositeCommandBuffer: NriCommandBufferHandle, public computeAllocator: NriCommandAllocatorHandle | null,
            public computeCommandBuffer: NriCommandBufferHandle | null, public shadowView: NriDescriptorHandle | null,
            public forwardView: NriDescriptorHandle | null, public shadowSet: NriDescriptorSetHandle | null) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // Port of Vulkan-Samples' async_compute (as examples/async_compute_bloom.ts ports it) to NRI: an
    // 8K shadow map and a 4K HDR forward pass of the Bonza scene on the graphics queue, an HDR bloom
    // (threshold, blur down, blur up) in compute shaders, and a tone mapping composite into the swap
    // chain. With async queues, the bloom runs on the compute queue: it waits for the HDR frame, and
    // the composite waits for it, on the GPU (the frame's graphics work in two submissions around
    // it). Without, everything runs on the graphics queue. As NVRHI's D3D11 device, D3D11 has no
    // compute queue here (NRI's D3D11 queues are one immediate context).
    //
    // Resource states across the queues: the graphics queue moves the HDR target from a color
    // attachment to ComputeShaderResource (what a D3D12 compute queue can read) and back, and the
    // bloom's output from Storage to a pixel shader resource for the composite and back; the compute
    // queue moves the blur chain between Storage and ComputeShaderResource. NRI's textures are
    // shared by the queues (Vulkan's concurrent sharing), so no ownership transfers.
    class AsyncComputeBloom {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        // Null without one (D3D11), or when the device has none.
        private computeQueue: NriQueueHandle | null = null;
        private computeQueueAvailable: boolean = false;
        private frameFence: NriFenceHandle;
        // The graphics queue's scene work done (the compute queue waits for it), the compute queue's
        // bloom done (the composite waits for it): frame index + 1 each.
        private graphicsFence: NriFenceHandle | null = null;
        private computeFence: NriFenceHandle | null = null;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private width: int = 0;
        private height: int = 0;

        // The sample's settings (-async, -doublebuffer, -norotate), from its UI; -benchmark: fixed
        // simulation steps, as the sample's benchmark mode; -noUI: no overlay.
        asyncEnabled: boolean = false;
        doubleBufferHdr: boolean = false;
        rotateShadows: boolean = true;
        benchmark: boolean = false;
        noUI: boolean = false;
        private imgui: boolean = false;
        private elapsedTime: number = 0.0;
        private hdrIndex: int = 0;

        private camera: DonutFirstPersonCamera = new DonutFirstPersonCamera(CAMERA_MOVE_SPEED, CAMERA_ROTATE_SPEED);

        private constantBuffer: NriBufferHandle | null = null;
        private vertexBuffer: NriBufferHandle | null = null;
        private indexBuffer: NriBufferHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private linearClamp: NriDescriptorHandle | null = null;
        private linearWrap: NriDescriptorHandle | null = null;
        private comparisonSampler: NriDescriptorHandle | null = null;

        // The shadow map: 16-bit depth (8K, "overkill to stress devices"), reversed; read by the
        // forward pass between the shadow passes.
        private shadowMap: NriTextureHandle | null = null;
        private shadowAttachment: NriDescriptorHandle | null = null;
        private shadowMapView: NriDescriptorHandle | null = null;
        private shadowLayout: NriPipelineLayoutHandle | null = null;
        private shadowPipeline: NriPipelineHandle | null = null;

        // The HDR targets, the compute post's input: RGBA16F, two for double buffering, with one
        // depth buffer (reversed); their states (NriTextureState).
        private hdrTargets: NriTextureHandle[] = [];
        private hdrAttachments: NriDescriptorHandle[] = [];
        private hdrViews: NriDescriptorHandle[] = [];
        private hdrStates: NriTextureState[] = [];
        private hdrDepth: NriTextureHandle | null = null;
        private hdrDepthAttachment: NriDescriptorHandle | null = null;
        private forwardLayout: NriPipelineLayoutHandle | null = null;
        private forwardPipeline: NriPipelineHandle | null = null;
        private forwardBlendPipeline: NriPipelineHandle | null = null;
        // The base color textures, one per image.
        private textures: NriTextureHandle[] = [];
        private textureViews: NriDescriptorHandle[] = [];

        // The bloom: the blur chain, levels 1 to BLUR_LEVELS of the HDR size (index level - 1),
        // RGBA16F, their views and states.
        private blurChain: NriTextureHandle[] = [];
        private blurViews: NriDescriptorHandle[] = [];
        private blurStorageViews: NriDescriptorHandle[] = [];
        private blurStates: NriTextureState[] = [];
        private postLayout: NriPipelineLayoutHandle | null = null;
        private thresholdPipeline: NriPipelineHandle | null = null;
        private blurDownPipeline: NriPipelineHandle | null = null;
        private blurUpPipeline: NriPipelineHandle | null = null;
        // The threshold pass from each HDR target, the blur down passes into blur levels 1 ..
        // BLUR_LEVELS - 1 (index level - 1), the blur up passes into levels BLUR_LEVELS - 2 .. 1
        // (index BLUR_LEVELS - 2 - level).
        private thresholdSets: NriDescriptorSetHandle[] = [];
        private blurDownSets: NriDescriptorSetHandle[] = [];
        private blurUpSets: NriDescriptorSetHandle[] = [];

        // The composite: from each HDR target, with the bloom.
        private compositeLayout: NriPipelineLayoutHandle | null = null;
        private compositePipeline: NriPipelineHandle | null = null;
        private compositeSets: NriDescriptorSetHandle[] = [];

        // The draws, a node's primitive each: index range and base vertex, base color texture,
        // alpha blending, node transform (MODEL_FLOATS each, from models), and world bounds center (3
        // each), in the framework's order: by mesh, node, primitive.
        private drawFirstIndex: int[] = [];
        private drawIndexCount: int[] = [];
        private drawBaseVertex: int[] = [];
        private drawTexture: int[] = [];
        private drawBlend: boolean[] = [];
        private drawCenters: number[] = [];
        private models: f32[] = [];
        // The draws in drawing order: opaque ones front to back, then blended ones back to front.
        private order: int[] = [];
        private distances: number[] = [];
        // The shadow pass's texture sets: none (drawScene binds them for the forward pass).
        private noSets: NriDescriptorSetHandle[] = [];

        // Upload buffers.
        private constants: f32[] = [];
        private blurConstants: f32[] = [];
        // Donut's view matrix, 16 floats.
        private viewMatrix: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.constants.push(0.0);
            }
            for (let i = 0; i < BLUR_FLOATS; i++) {
                this.blurConstants.push(0.0);
            }
            for (let i = 0; i < 16; i++) {
                this.viewMatrix.push(0.0);
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

        hasComputeQueue() {
            return this.computeQueueAvailable;
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

            // The compute queue, with the fences between the queues (none on D3D11, as NVRHI's).
            if (graphicsAPI != NriGraphicsAPI.D3D11) {
                const computeQueue = Nri_GetComputeQueue(device);
                if (computeQueue) {
                    this.computeQueue = computeQueue;
                    this.computeQueueAvailable = true;
                    this.graphicsFence = Nri_CreateFence(device, 0);
                    this.computeFence = Nri_CreateFence(device, 0);
                }
            }
            if (this.asyncEnabled && !this.hasComputeQueue()) {
                console.log("The graphics device has no compute queue: running on one queue");
            }

            // Swap chain: rendered through sRGB views, as into Donut's sRGB back buffers.
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

            // The sample's samplers: linear and clamped for the post passes, a comparison one for the
            // shadow map; the scene's (linear, repeating) for its textures (Donut's common ones).
            this.linearClamp = Nri_CreateSamplerWithMipFilter(device, NriFilter.Linear, NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
            this.linearWrap = Nri_CreateSamplerWithMipFilter(device, NriFilter.Linear, NriFilter.Linear, NriAddressMode.Repeat, 1);
            this.comparisonSampler = Nri_CreateComparisonSampler(device, NriCompareOp.Less);
            const linearClamp = this.linearClamp;
            const linearWrap = this.linearWrap;
            const comparisonSampler = this.comparisonSampler;
            if (!linearClamp || !linearWrap || !comparisonSampler) {
                console.log("Cannot create the samplers");
                return 0;
            }

            // The targets: the shadow map, the HDR targets and their depth buffer, the blur chain.
            const shadowMap = Nri_CreateSampledDepthTexture(device, this.queue, SHADOW_RESOLUTION, SHADOW_RESOLUTION, NriFormat.D16_UNORM);
            this.shadowMap = shadowMap;
            const hdrDepth = Nri_CreateDepthTexture(device, this.queue, HDR_WIDTH, HDR_HEIGHT, NriFormat.D32_SFLOAT);
            this.hdrDepth = hdrDepth;
            if (!shadowMap || !hdrDepth) {
                console.log("Cannot create the depth buffers");
                return 0;
            }
            this.shadowAttachment = Nri_CreateDepthAttachmentView(shadowMap, NriFormat.D16_UNORM);
            const shadowMapView = Nri_CreateTextureView(shadowMap, NriFormat.D16_UNORM);
            this.shadowMapView = shadowMapView;
            this.hdrDepthAttachment = Nri_CreateDepthAttachmentView(hdrDepth, NriFormat.D32_SFLOAT);
            for (let i = 0; i < 2; i++) {
                const target = Nri_CreateRenderTargetTexture(device, this.queue, HDR_WIDTH, HDR_HEIGHT, NriFormat.RGBA16_SFLOAT);
                if (!target) {
                    console.log("Cannot create the HDR targets");
                    return 0;
                }
                this.hdrTargets.push(target);
                this.hdrAttachments.push(Nri_CreateColorAttachmentView(target, NriFormat.RGBA16_SFLOAT));
                this.hdrViews.push(Nri_CreateTextureView(target, NriFormat.RGBA16_SFLOAT));
                this.hdrStates.push(NriTextureState.ShaderResource);
            }
            for (let level = 1; level <= BLUR_LEVELS; level++) {
                const texture = Nri_CreateStorageTexture(device, this.queue, levelWidth(level), levelHeight(level), NriFormat.RGBA16_SFLOAT);
                if (!texture) {
                    console.log("Cannot create the blur chain");
                    return 0;
                }
                this.blurChain.push(texture);
                this.blurViews.push(Nri_CreateTextureView(texture, NriFormat.RGBA16_SFLOAT));
                this.blurStorageViews.push(Nri_CreateStorageTextureView(texture, NriFormat.RGBA16_SFLOAT));
                this.blurStates.push(NriTextureState.Storage);
            }

            // The scene: its vertices, indices, base color textures and draws.
            if (!this.loadScene(device)) {
                console.log("Cannot load the scene and its textures: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }

            // The layouts: the shadow pass's scene uniform (b0) and node transform (b1: root
            // constants); the forward pass's too, with the base color texture and its sampler (t0,
            // s0) and the shadow map and its comparison sampler (t1, s1); the bloom's input and its
            // sampler (t0, s0), output (u0) and resolutions (b0: root constants); the composite's HDR
            // frame and bloom (t0, t1) and sampler (s0).
            const shadowLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(shadowLayoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRootConstants(shadowLayoutDesc, 1, MODEL_SIZE, NriStage.VertexPixel);
            this.shadowLayout = Nri_CreatePipelineLayoutFromDesc(device, shadowLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(shadowLayoutDesc);
            const forwardLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(forwardLayoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(forwardLayoutDesc, 0, 0, 2, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(forwardLayoutDesc, 0, 0, 2, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRootConstants(forwardLayoutDesc, 1, MODEL_SIZE, NriStage.VertexPixel);
            this.forwardLayout = Nri_CreatePipelineLayoutFromDesc(device, forwardLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(forwardLayoutDesc);
            const postLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(postLayoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Compute, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(postLayoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Compute, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(postLayoutDesc, 0, 0, 1, NriDescriptorType.StorageTexture, NriStage.Compute, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRootConstants(postLayoutDesc, 0, BLUR_SIZE, NriStage.Compute);
            this.postLayout = Nri_CreatePipelineLayoutFromDesc(device, postLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(postLayoutDesc);
            const compositeLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(compositeLayoutDesc, 0, 0, 2, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(compositeLayoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            this.compositeLayout = Nri_CreatePipelineLayoutFromDesc(device, compositeLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(compositeLayoutDesc);
            const shadowLayout = this.shadowLayout;
            const forwardLayout = this.forwardLayout;
            const postLayout = this.postLayout;
            const compositeLayout = this.compositeLayout;
            if (!shadowLayout || !forwardLayout || !postLayout || !compositeLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The pipelines: the Donut example's shaders, as compiled for it.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/async_compute_bloom/${folder}/async_compute_bloom`;
            this.shadowPipeline = this.createShadowPipeline(device, shadowLayout, shaders);
            this.forwardPipeline = this.createForwardPipeline(device, forwardLayout, shaders, false);
            this.forwardBlendPipeline = this.createForwardPipeline(device, forwardLayout, shaders, true);
            this.thresholdPipeline = Nri_CreateComputePipeline(device, postLayout, `${shaders}_post_threshold_cs.bin`, "threshold_cs");
            this.blurDownPipeline = Nri_CreateComputePipeline(device, postLayout, `${shaders}_post_blur_down_cs.bin`, "blur_down_cs");
            this.blurUpPipeline = Nri_CreateComputePipeline(device, postLayout, `${shaders}_post_blur_up_cs.bin`, "blur_up_cs");
            this.compositePipeline = this.createCompositePipeline(device, compositeLayout, shaders);
            if (!this.shadowPipeline || !this.forwardPipeline || !this.forwardBlendPipeline || !this.thresholdPipeline
                || !this.blurDownPipeline || !this.blurUpPipeline || !this.compositePipeline) {
                console.log("Cannot load the async compute bloom shaders");
                return 0;
            }

            // The descriptor sets: per queued frame, the shadow pass's and the forward pass's per
            // texture (its constant buffer views); the bloom's and the composite's.
            const textureCount = this.textures.length;
            const frameSetNum = 1 + textureCount;
            const postSetNum = 2 + (BLUR_LEVELS - 1) + (BLUR_LEVELS - 2);
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * 2 * CONST_VIEW_SIZE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const descriptorPool = Nri_CreateDescriptorPool(device, queuedFrameNum * frameSetNum + postSetNum + 2,
                queuedFrameNum * textureCount * 2 + postSetNum + 2, queuedFrameNum * frameSetNum,
                queuedFrameNum * textureCount * 2 + postSetNum + 4, postSetNum, 0);
            this.descriptorPool = descriptorPool;
            if (!constantBuffer || !descriptorPool) {
                console.log("Cannot create the descriptors");
                return 0;
            }
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const computeQueue = this.computeQueue;
                let computeAllocator: NriCommandAllocatorHandle | null = null;
                let computeCommandBuffer: NriCommandBufferHandle | null = null;
                if (computeQueue) {
                    const allocator = Nri_CreateCommandAllocator(computeQueue);
                    computeAllocator = allocator;
                    computeCommandBuffer = Nri_CreateCommandBuffer(allocator);
                }
                const shadowView = Nri_CreateConstantBufferView(constantBuffer, (2 * i) * CONST_VIEW_SIZE, CONST_VIEW_SIZE);
                const forwardView = Nri_CreateConstantBufferView(constantBuffer, (2 * i + 1) * CONST_VIEW_SIZE, CONST_VIEW_SIZE);
                const shadowSet = Nri_AllocateDescriptorSet(descriptorPool, shadowLayout, 0, 0);
                const queuedFrame = new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator),
                    Nri_CreateCommandBuffer(commandAllocator), computeAllocator, computeCommandBuffer, shadowView, forwardView, shadowSet);
                this.queuedFrames.push(queuedFrame);
                if (!shadowView || !forwardView || !shadowSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(shadowSet, 0, 0, shadowView);
                for (let t = 0; t < textureCount; t++) {
                    const forwardSet = Nri_AllocateDescriptorSet(descriptorPool, forwardLayout, 0, 0);
                    if (!forwardSet) {
                        console.log("Cannot create the descriptor sets");
                        return 0;
                    }
                    queuedFrame.forwardSets.push(forwardSet);
                    Nri_UpdateDescriptor(forwardSet, 0, 0, forwardView);
                    Nri_UpdateDescriptor(forwardSet, 1, 0, this.textureViews[t]);
                    Nri_UpdateDescriptor(forwardSet, 1, 1, shadowMapView);
                    Nri_UpdateDescriptor(forwardSet, 2, 0, linearWrap);
                    Nri_UpdateDescriptor(forwardSet, 2, 1, comparisonSampler);
                }
            }
            for (let i = 0; i < 2; i++) {
                const thresholdSet = this.createBlurSet(descriptorPool, postLayout, this.hdrViews[i], this.blurStorageViews[0]);
                const compositeSet = Nri_AllocateDescriptorSet(descriptorPool, compositeLayout, 0, 0);
                if (!thresholdSet || !compositeSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                this.thresholdSets.push(thresholdSet);
                this.compositeSets.push(compositeSet);
                Nri_UpdateDescriptor(compositeSet, 0, 0, this.hdrViews[i]);
                Nri_UpdateDescriptor(compositeSet, 0, 1, this.blurViews[BLOOM_INDEX]);
                Nri_UpdateDescriptor(compositeSet, 1, 0, linearClamp);
            }
            for (let index = 1; index < BLUR_LEVELS; index++) {
                const blurSet = this.createBlurSet(descriptorPool, postLayout, this.blurViews[index - 1], this.blurStorageViews[index]);
                if (!blurSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                this.blurDownSets.push(blurSet);
            }
            for (let index = BLUR_LEVELS - 2; index >= 1; index--) {
                const blurSet = this.createBlurSet(descriptorPool, postLayout, this.blurViews[index + 1], this.blurStorageViews[index]);
                if (!blurSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                this.blurUpSets.push(blurSet);
            }

            // The scene's camera, as the sample's free camera starts.
            const q = CAMERA_ROTATION;
            const forward = [-2.0 * (q[0] * q[2] + q[3] * q[1]), -2.0 * (q[1] * q[2] - q[3] * q[0]), -(1.0 - 2.0 * (q[0] * q[0] + q[1] * q[1]))];
            const p = CAMERA_POSITION;
            this.camera.lookAt(p[0], p[1], p[2], p[0] + forward[0], p[1] + forward[1], p[2] + forward[2]);

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

        // A bloom pass's set: its input and sampler, its output.
        createBlurSet(descriptorPool: NriDescriptorPoolHandle, layout: NriPipelineLayoutHandle, input: NriDescriptorHandle,
            output: NriDescriptorHandle) {
            const linearClamp = this.linearClamp;
            const blurSet = Nri_AllocateDescriptorSet(descriptorPool, layout, 0, 0);
            if (!blurSet || !linearClamp) {
                return null;
            }
            Nri_UpdateDescriptor(blurSet, 0, 0, input);
            Nri_UpdateDescriptor(blurSet, 1, 0, linearClamp);
            Nri_UpdateDescriptor(blurSet, 2, 0, output);
            return blurSet;
        }

        // The framework's geometry pipeline state: reversed depth (greater), back faces culled,
        // counter-clockwise front faces; plus the sample's depth bias against shadow acne. Positions
        // only, no color.
        createShadowPipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, shaders: string) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_shadow_vs.bin`, "shadow_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_shadow_ps.bin`, "shadow_ps") != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescSetCullMode(desc, NriCullMode.Back);
            Nri_PipelineDescSetFrontCounterClockwise(desc, 1);
            Nri_PipelineDescSetDepth(desc, NriFormat.D16_UNORM, NriCompareOp.Greater, 1, 0);
            Nri_PipelineDescSetDepthBias(desc, SHADOW_DEPTH_BIAS, 0.0, SHADOW_SLOPE_SCALED_DEPTH_BIAS);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // The forward pass's: into the HDR target (RGBA16F), the framework's geometry state; the
        // blended materials alpha blended (Donut's AlphaBlend).
        createForwardPipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, shaders: string, blend: boolean) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_forward_vs.bin`, "forward_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_forward_ps.bin`, "forward_ps") != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescAddVertexAttribute(desc, "NORMAL", NriFormat.RGB32_SFLOAT, NORMAL_OFFSET);
            Nri_PipelineDescAddVertexAttribute(desc, "TEXCOORD", NriFormat.RG32_SFLOAT, TEXCOORD_OFFSET);
            Nri_PipelineDescSetCullMode(desc, NriCullMode.Back);
            Nri_PipelineDescSetFrontCounterClockwise(desc, 1);
            Nri_PipelineDescSetColor(desc, NriFormat.RGBA16_SFLOAT, NriColorWrite.RGBA);
            if (blend) {
                Nri_PipelineDescSetBlend(desc, NriBlendFactor.SrcAlpha, NriBlendFactor.OneMinusSrcAlpha, NriBlendOp.Add,
                    NriBlendFactor.OneMinusSrcAlpha, NriBlendFactor.Zero, NriBlendOp.Add);
            }
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.Greater, 1, 0);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // The composite's: a triangle over the screen into the swap chain's sRGB view.
        createCompositePipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, shaders: string) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_composite_vs.bin`, "composite_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_composite_ps.bin`, "composite_ps") != 0;
            }
            Nri_PipelineDescSetCullMode(desc, NriCullMode.None);
            Nri_PipelineDescSetColor(desc, this.viewFormat, NriColorWrite.RGBA);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // The scene's base color textures and its draws: every node's primitives, their vertices and
        // indices in one vertex and one index buffer.
        loadScene(device: NriDeviceHandle) {
            const scene = Nri_LoadGltfModel(SCENE_PATH);
            if (!scene) {
                return false;
            }
            const loaded = this.loadSceneFrom(device, scene);
            Nri_DestroyGltfModel(scene);
            return loaded;
        }

        loadSceneFrom(device: NriDeviceHandle, scene: NriGltfModelHandle) {
            const primitiveCount = Nri_GetGltfModelPrimitiveCount(scene);

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
                const image = Nri_GetGltfModelBaseColorImage(scene, p);
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

                const mesh = Nri_GetGltfModelPrimitiveMesh(scene, p);
                if (mesh == meshFirstPrimitive.length) {
                    meshFirstPrimitive.push(p);
                    for (let k = 0; k < 3; k++) {
                        meshBounds.push(HUGE);
                    }
                    for (let k = 0; k < 3; k++) {
                        meshBounds.push(-HUGE);
                    }
                }

                const vertexCount = Nri_GetGltfModelVertexCount(scene, p);
                const indexCount = Nri_GetGltfModelIndexCount(scene, p);
                const primitiveVertices: f32[] = [];
                for (let i = 0; i < vertexCount * VERTEX_FLOATS; i++) {
                    primitiveVertices.push(0.0);
                }
                const primitiveIndices: int[] = [];
                for (let i = 0; i < indexCount; i++) {
                    primitiveIndices.push(0);
                }
                Nri_CopyGltfModelVertices(scene, p, Ref(primitiveVertices[0]));
                Nri_CopyGltfModelIndices(scene, p, Ref(primitiveIndices[0]));

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
            // here, with the mip levels generated), sRGB.
            for (const name of imageNames) {
                const dot = name.lastIndexOf(".");
                const path = SCENE_DIR + (dot >= 0 ? name.substring(0, dot) : name) + ".dds";
                const texture = Nri_LoadDdsTexture(device, this.queue, path, 1);
                if (!texture) {
                    return false;
                }
                this.textures.push(texture);
                this.textureViews.push(Nri_CreateTextureView(texture, NriFormat.RGBA8_SRGB));
            }

            // The draws: by mesh, then node, then primitive, as the framework's meshes list their
            // nodes and submeshes.
            const nodeCount = Nri_GetGltfModelNodeCount(scene);
            const transform: f32[] = [];
            for (let i = 0; i < 16; i++) {
                transform.push(0.0);
            }
            for (let mesh = 0; mesh + 1 < meshFirstPrimitive.length; mesh++) {
                for (let node = 0; node < nodeCount; node++) {
                    if (Nri_GetGltfModelNodeMesh(scene, node) != mesh) {
                        continue;
                    }
                    Nri_CopyGltfModelNodeTransform(scene, node, Ref(transform[0]));
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
                        this.drawIndexCount.push(Nri_GetGltfModelIndexCount(scene, p));
                        this.drawBaseVertex.push(primitiveBaseVertex[p]);
                        this.drawTexture.push(primitiveTexture[p]);
                        this.drawBlend.push(Nri_GetGltfModelPrimitiveAlphaMode(scene, p) == 2);
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

            const vertexBuffer = Nri_CreateUploadedBuffer(device, this.queue, Ref(vertices[0]), vertices.length * 4, NriBufferUsage.VertexBuffer);
            const indexBuffer = Nri_CreateUploadedBufferFromInts(device, this.queue, Ref(indices[0]), indices.length * 4, NriBufferUsage.IndexBuffer);
            this.vertexBuffer = vertexBuffer;
            this.indexBuffer = indexBuffer;
            if (!vertexBuffer || !indexBuffer) {
                return false;
            }
            return true;
        }

        // Waits for the frame that last used this frame's command allocators (and constants).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
            const computeAllocator = queuedFrame.computeAllocator;
            if (computeAllocator) {
                Nri_ResetCommandAllocator(computeAllocator);
            }
        }

        // The camera (Donut's FirstPersonCamera, the mouse unless the overlay has it) and the time,
        // over the frame's (Donut's test mode: 1/60 s, as a float).
        animate() {
            const elapsedSeconds = this.test ? Math.fround(1.0 / 60.0) : Nri_GetFrameTime(this.sample);
            const mouseFree = !this.imgui || Nri_ImguiWantsMouse() == 0;
            this.camera.animate(this.sample, elapsedSeconds, mouseFree);
            this.elapsedTime += this.benchmark ? BENCHMARK_FRAME_TIME : elapsedSeconds;
        }

        // The sample's options window.
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPos(10.0, 10.0);
            Nri_ImguiBegin("Options", 1);
            if (this.hasComputeQueue()) {
                this.asyncEnabled = Nri_ImguiCheckbox("Enable async queues", this.asyncEnabled ? 1 : 0) != 0;
            } else {
                Nri_ImguiText("No compute queue: no async queues");
            }
            this.doubleBufferHdr = Nri_ImguiCheckbox("Double buffer HDR", this.doubleBufferHdr ? 1 : 0) != 0;
            this.rotateShadows = Nri_ImguiCheckbox("Rotate shadows", this.rotateShadows ? 1 : 0) != 0;
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        // The sample's update: the directional light's (and shadow camera's) orientation, "lots of
        // random jank to get a desired orientation quaternion", turning once every 20 seconds when
        // the shadows rotate.
        lightOrientation() {
            let orientation = quatMultiply(angleAxis(Math.PI, 0.0, -1.0, 0.0), angleAxis(-0.2 * 0.5 * Math.PI, 1.0, 0.0, 0.0));
            if (this.rotateShadows) {
                const turns = this.elapsedTime * 0.05;
                orientation = quatMultiply(orientation, angleAxis(2.0 * Math.PI * (turns - Math.floor(turns)), 0.0, 0.0, -1.0));
                orientation = quatMultiply(orientation, angleAxis(-0.05 * 0.5 * Math.PI, 1.0, 0.0, 0.0));
            }
            return quatNormalize(orientation);
        }

        // The scene uniforms of both passes: the shadow camera's (on the light's node, at the
        // origin) and the main camera's view-projections, in Donut's clip space; the sample's
        // shadow matrix (its shadow clip space to texture coordinates); the light; into this frame's
        // constant buffer views.
        updateConstants(queuedFrameIndex: int) {
            const constantBuffer = this.constantBuffer;
            if (!constantBuffer) {
                return;
            }
            const light = quatToMatrix(this.lightOrientation());
            // The shadow camera's view: the inverse of its node's rotation.
            const shadowView = transpose(light);
            const shadowClip = multiply(vulkanStyleProjection(reversedOrtho(SHADOW_LEFT, SHADOW_RIGHT, SHADOW_BOTTOM, SHADOW_TOP,
                SHADOW_NEAR, SHADOW_FAR)), shadowView);
            // translate(0.5, 0.5, 0) * scale(0.5, 0.5, 1) * shadowClip
            let bias = identity();
            bias[0] = 0.5;
            bias[5] = 0.5;
            bias[12] = 0.5;
            bias[13] = 0.5;
            const shadowMatrix = multiply(bias, shadowClip);

            // Donut's camera, in Donut's view space (z forward), into the sample's (-z forward).
            const worldToView = this.camera.worldToView();
            for (let i = 0; i < 16; i++) {
                this.viewMatrix[i] = worldToView[i];
            }
            const view: number[] = [];
            for (let i = 0; i < 16; i++) {
                view.push(i % 4 == 2 ? -this.viewMatrix[i] : this.viewMatrix[i]);
            }
            const viewProj = multiply(vulkanStyleProjection(reversedPerspective(CAMERA_FOV, this.width / this.height, Z_NEAR, Z_FAR)), view);

            const c = this.constants;
            const donutShadowClip = toDonutClip(shadowClip);
            for (let i = 0; i < 16; i++) {
                c[CONST_VIEW_PROJ + i] = donutShadowClip[i];
                c[CONST_SHADOW_MATRIX + i] = shadowMatrix[i];
            }
            for (let i = 0; i < 4; i++) {
                c[CONST_LIGHT_COLOR + i] = LIGHT_COLOR[i];
            }
            // The light's direction: its node's rotation of (0, 0, -1).
            c[CONST_LIGHT_DIRECTION] = -light[8];
            c[CONST_LIGHT_DIRECTION + 1] = -light[9];
            c[CONST_LIGHT_DIRECTION + 2] = -light[10];
            c[CONST_LIGHT_DIRECTION + 3] = 0.0;
            Nri_WriteBuffer(constantBuffer, (2 * queuedFrameIndex) * CONST_VIEW_SIZE, Ref(c[0]), CONST_FLOATS * 4);

            const donutViewProj = toDonutClip(viewProj);
            for (let i = 0; i < 16; i++) {
                c[CONST_VIEW_PROJ + i] = donutViewProj[i];
            }
            Nri_WriteBuffer(constantBuffer, (2 * queuedFrameIndex + 1) * CONST_VIEW_SIZE, Ref(c[0]), CONST_FLOATS * 4);
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
            // Opaque draws, then blended ones; each in the framework's order.
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

        // The scene's draws in order (between Nri_CmdBeginRendering... and Nri_CmdEndRendering): the
        // forward pass's with their base color texture's set (forwardSets) and the blended ones
        // blended; the shadow pass's with its set (forwardSets empty).
        drawScene(commandBuffer: NriCommandBufferHandle, pipeline: NriPipelineHandle, blendPipeline: NriPipelineHandle,
            forwardSets: NriDescriptorSetHandle[]) {
            const vertexBuffer = this.vertexBuffer;
            const indexBuffer = this.indexBuffer;
            if (!vertexBuffer || !indexBuffer) {
                return;
            }
            Nri_CmdSetIndexBuffer(commandBuffer, indexBuffer, 0, NriIndexType.UInt32);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, vertexBuffer, 0, VERTEX_SIZE);
            const forward = forwardSets.length > 0;
            // The blending (-1 before the first draw) and texture set.
            let currentBlend = -1;
            let currentTexture = -1;
            for (const d of this.order) {
                const blend = this.drawBlend[d] ? 1 : 0;
                if (blend != currentBlend) {
                    Nri_CmdSetPipeline(commandBuffer, blend == 1 ? blendPipeline : pipeline);
                    currentBlend = blend;
                }
                const texture = forward ? this.drawTexture[d] : 0;
                if (forward && texture != currentTexture) {
                    Nri_CmdSetDescriptorSet(commandBuffer, 0, forwardSets[texture]);
                    currentTexture = texture;
                }
                Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.models[d * MODEL_FLOATS]), MODEL_SIZE);
                Nri_CmdDrawIndexed(commandBuffer, this.drawIndexCount[d], 1, this.drawFirstIndex[d], this.drawBaseVertex[d], 0);
            }
        }

        // The sample's render_shadow_pass: the scene's depth from the light, into the shadow map
        // (reversed depth, cleared to 0), left for the forward pass to read.
        renderShadowPass(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const shadowMap = this.shadowMap;
            const shadowAttachment = this.shadowAttachment;
            const shadowLayout = this.shadowLayout;
            const shadowPipeline = this.shadowPipeline;
            const shadowSet = queuedFrame.shadowSet;
            if (!shadowMap || !shadowAttachment || !shadowLayout || !shadowPipeline || !shadowSet) {
                return;
            }
            Nri_CmdTextureBarrier(commandBuffer, shadowMap, NriTextureState.ShaderResource, NriTextureState.DepthAttachment);
            Nri_CmdBeginRenderingDepthOnly(commandBuffer, shadowAttachment);
            Nri_CmdClearDepth(commandBuffer, 0.0);
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, SHADOW_RESOLUTION, SHADOW_RESOLUTION);
            Nri_CmdSetScissor(commandBuffer, 0, 0, SHADOW_RESOLUTION, SHADOW_RESOLUTION);
            Nri_CmdSetPipelineLayout(commandBuffer, shadowLayout);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, shadowSet);
            // The shadow camera's node is at the origin.
            this.sortDraws(0.0, 0.0, 0.0);
            this.drawScene(commandBuffer, shadowPipeline, shadowPipeline, this.noSets);
            Nri_CmdEndRendering(commandBuffer);
            Nri_CmdTextureBarrier(commandBuffer, shadowMap, NriTextureState.DepthAttachment, NriTextureState.ShaderResource);
        }

        // The sample's render_forward_offscreen_pass: the lit and shadowed scene into the HDR target,
        // left for the bloom (compute shaders, on either queue) to read.
        renderForwardPass(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const hdrDepthAttachment = this.hdrDepthAttachment;
            const forwardLayout = this.forwardLayout;
            const forwardPipeline = this.forwardPipeline;
            const forwardBlendPipeline = this.forwardBlendPipeline;
            if (!hdrDepthAttachment || !forwardLayout || !forwardPipeline || !forwardBlendPipeline) {
                return;
            }
            const hdrIndex = this.hdrIndex;
            this.setHdrState(commandBuffer, hdrIndex, NriTextureState.ColorAttachment);
            Nri_CmdBeginRenderingWithDepth(commandBuffer, this.hdrAttachments[hdrIndex], hdrDepthAttachment);
            Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 1.0);
            Nri_CmdClearDepth(commandBuffer, 0.0);
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, HDR_WIDTH, HDR_HEIGHT);
            Nri_CmdSetScissor(commandBuffer, 0, 0, HDR_WIDTH, HDR_HEIGHT);
            Nri_CmdSetPipelineLayout(commandBuffer, forwardLayout);
            const view = this.viewMatrix;
            // The camera's position: -R^T t of its view [R t].
            const position: number[] = [0.0, 0.0, 0.0];
            for (let column = 0; column < 3; column++) {
                for (let row = 0; row < 3; row++) {
                    position[column] -= view[column * 4 + row] * view[12 + row];
                }
            }
            this.sortDraws(position[0], position[1], position[2]);
            this.drawScene(commandBuffer, forwardPipeline, forwardBlendPipeline, queuedFrame.forwardSets);
            Nri_CmdEndRendering(commandBuffer);
            this.setHdrState(commandBuffer, hdrIndex, NriTextureState.ComputeShaderResource);
        }

        // A barrier moving HDR target index to state, unless it's in it (or both only read it).
        setHdrState(commandBuffer: NriCommandBufferHandle, index: int, state: NriTextureState) {
            if (needsBarrier(this.hdrStates[index], state)) {
                Nri_CmdTextureBarrier(commandBuffer, this.hdrTargets[index], this.hdrStates[index], state);
            }
            this.hdrStates[index] = state;
        }

        // A barrier moving blur chain texture index to state, unless it's in it (or both only read it).
        setBlurState(commandBuffer: NriCommandBufferHandle, index: int, state: NriTextureState) {
            if (needsBarrier(this.blurStates[index], state)) {
                Nri_CmdTextureBarrier(commandBuffer, this.blurChain[index], this.blurStates[index], state);
            }
            this.blurStates[index] = state;
        }

        // One bloom pass: its input (ComputeShaderResource) read, its output (Storage) written, a
        // thread per texel of the output.
        dispatchBlurPass(commandBuffer: NriCommandBufferHandle, pipeline: NriPipelineHandle | null, blurSet: NriDescriptorSetHandle,
            input: int, output: int, width: int, height: int, inputWidth: int, inputHeight: int) {
            if (!pipeline) {
                return;
            }
            if (input >= 0) {
                this.setBlurState(commandBuffer, input, NriTextureState.ComputeShaderResource);
            }
            this.setBlurState(commandBuffer, output, NriTextureState.Storage);
            const b = this.blurConstants;
            Nri_StoreInt32(Ref(b[0]), width);
            Nri_StoreInt32(Ref(b[1]), height);
            b[2] = 1.0 / width;
            b[3] = 1.0 / height;
            b[4] = 1.0 / inputWidth;
            b[5] = 1.0 / inputHeight;
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetComputeDescriptorSet(commandBuffer, 0, blurSet);
            Nri_CmdSetComputeRootConstants(commandBuffer, 0, Ref(b[0]), BLUR_SIZE);
            Nri_CmdDispatch(commandBuffer, Math.floor((width + BLUR_GROUP_SIZE - 1) / BLUR_GROUP_SIZE),
                Math.floor((height + BLUR_GROUP_SIZE - 1) / BLUR_GROUP_SIZE), 1);
        }

        // The sample's render_compute_post: "a very basic and dumb HDR Bloom pipeline", a threshold
        // pass into the first blur level, then blurring down the levels and back up to the second
        // (left in Storage, for the composite on the graphics queue to read).
        renderComputePost(commandBuffer: NriCommandBufferHandle) {
            const descriptorPool = this.descriptorPool;
            const postLayout = this.postLayout;
            if (!descriptorPool || !postLayout) {
                return;
            }
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetComputePipelineLayout(commandBuffer, postLayout);
            this.dispatchBlurPass(commandBuffer, this.thresholdPipeline, this.thresholdSets[this.hdrIndex], -1, 0,
                levelWidth(1), levelHeight(1), HDR_WIDTH, HDR_HEIGHT);
            for (let index = 1; index < BLUR_LEVELS; index++) {
                this.dispatchBlurPass(commandBuffer, this.blurDownPipeline, this.blurDownSets[index - 1], index - 1, index,
                    levelWidth(index + 1), levelHeight(index + 1), levelWidth(index), levelHeight(index));
            }
            for (let index = BLUR_LEVELS - 2; index >= 1; index--) {
                this.dispatchBlurPass(commandBuffer, this.blurUpPipeline, this.blurUpSets[BLUR_LEVELS - 2 - index], index + 1, index,
                    levelWidth(index + 1), levelHeight(index + 1), levelWidth(index + 2), levelHeight(index + 2));
            }
            this.setBlurState(commandBuffer, BLOOM_INDEX, NriTextureState.Storage);
        }

        // The sample's render_swapchain: the HDR frame and the bloom to pixel shader resources (on
        // the graphics queue: a D3D12 compute queue can't take them there), the composite into the
        // swap chain texture, the overlay over it; then the test's read back.
        recordComposite(commandBuffer: NriCommandBufferHandle, swapChainTexture: SwapChainTexture, frameIndex: int) {
            const descriptorPool = this.descriptorPool;
            const compositeLayout = this.compositeLayout;
            const compositePipeline = this.compositePipeline;
            if (!descriptorPool || !compositeLayout || !compositePipeline) {
                return;
            }
            this.setHdrState(commandBuffer, this.hdrIndex, NriTextureState.ShaderResource);
            this.setBlurState(commandBuffer, BLOOM_INDEX, NriTextureState.ShaderResource);
            Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
            Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, compositeLayout);
            Nri_CmdSetPipeline(commandBuffer, compositePipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, this.compositeSets[this.hdrIndex]);
            Nri_CmdDraw(commandBuffer, 3, 1, 0, 0);
            if (this.imgui) {
                Nri_CmdDrawImgui(this.sample, commandBuffer, this.viewFormat);
            }
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
        }

        // The scene's passes: the shadow map, the HDR frame; the bloom's output back to Storage from
        // the last composite's reading (on the graphics queue, as its reading state is one a D3D12
        // compute queue can't leave).
        recordScene(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const descriptorPool = this.descriptorPool;
            if (!descriptorPool) {
                return;
            }
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            this.renderShadowPass(commandBuffer, queuedFrame);
            this.renderForwardPass(commandBuffer, queuedFrame);
            this.setBlurState(commandBuffer, BLOOM_INDEX, NriTextureState.Storage);
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.animate();

            // Double buffered HDR: the next frame can run ahead a little further before it needs to
            // block.
            this.hdrIndex = this.doubleBufferHdr ? 1 - this.hdrIndex : 0;
            this.updateConstants(queuedFrameIndex);

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;
                const asyncQueues = this.asyncEnabled && this.hasComputeQueue();

                // The scene on the graphics queue; the bloom after it, on the same command buffer
                // without async queues.
                Nri_BeginCommandBuffer(commandBuffer);
                this.recordScene(commandBuffer, queuedFrame);
                if (!asyncQueues) {
                    this.renderComputePost(commandBuffer);
                    if (this.imgui) {
                        Nri_CmdCopyImguiData(this.sample, commandBuffer);
                    }
                    this.recordComposite(commandBuffer, swapChainTexture, frameIndex);
                }
                Nri_EndCommandBuffer(commandBuffer);

                if (!asyncQueues) {
                    Nri_QueueSubmit(this.queue, commandBuffer, acquireSemaphore, swapChainTexture.releaseSemaphore);
                } else {
                    this.submitAsync(frameIndex, queuedFrame, swapChainTexture, acquireSemaphore);
                }
                if (this.imgui) {
                    Nri_ImguiEndFrame(this.sample);
                }
                Nri_QueuePresent(this.swapChain, swapChainTexture.releaseSemaphore);
            }

            // Signaled after the present, as NRISamples do
            Nri_QueueSignal(this.queue, this.frameFence, 1 + frameIndex);
        }

        // With async queues: the scene's submission signals the graphics fence; the bloom on the
        // compute queue waits for it and signals the compute fence; the composite waits for that
        // (Nri_QueueWait), then for the swap chain texture, and presents (Donut's
        // executeFrameComputeWork).
        submitAsync(frameIndex: int, queuedFrame: QueuedFrame, swapChainTexture: SwapChainTexture, acquireSemaphore: NriFenceHandle) {
            const computeQueue = this.computeQueue;
            const computeCommandBuffer = queuedFrame.computeCommandBuffer;
            const graphicsFence = this.graphicsFence;
            const computeFence = this.computeFence;
            if (!computeQueue || !computeCommandBuffer || !graphicsFence || !computeFence) {
                return;
            }
            Nri_QueueSubmitWithFences(this.queue, queuedFrame.commandBuffer, null, 0, graphicsFence, 1 + frameIndex);

            Nri_BeginCommandBuffer(computeCommandBuffer);
            this.renderComputePost(computeCommandBuffer);
            Nri_EndCommandBuffer(computeCommandBuffer);
            Nri_QueueSubmitWithFences(computeQueue, computeCommandBuffer, graphicsFence, 1 + frameIndex, computeFence, 1 + frameIndex);

            const compositeCommandBuffer = queuedFrame.compositeCommandBuffer;
            Nri_BeginCommandBuffer(compositeCommandBuffer);
            if (this.imgui) {
                Nri_CmdCopyImguiData(this.sample, compositeCommandBuffer);
            }
            this.recordComposite(compositeCommandBuffer, swapChainTexture, frameIndex);
            Nri_EndCommandBuffer(compositeCommandBuffer);
            Nri_QueueWait(this.queue, computeFence, 1 + frameIndex);
            Nri_QueueSubmit(this.queue, compositeCommandBuffer, acquireSemaphore, swapChainTexture.releaseSemaphore);
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
                    Nri_DestroyCommandBuffer(queuedFrame.compositeCommandBuffer);
                    Nri_DestroyCommandAllocator(queuedFrame.commandAllocator);
                    const computeCommandBuffer = queuedFrame.computeCommandBuffer;
                    if (computeCommandBuffer) {
                        Nri_DestroyCommandBuffer(computeCommandBuffer);
                    }
                    const computeAllocator = queuedFrame.computeAllocator;
                    if (computeAllocator) {
                        Nri_DestroyCommandAllocator(computeAllocator);
                    }
                    this.destroyDescriptor(queuedFrame.shadowView);
                    this.destroyDescriptor(queuedFrame.forwardView);
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
                for (let i = 0; i < this.hdrTargets.length; i++) {
                    Nri_DestroyDescriptor(this.hdrAttachments[i]);
                    Nri_DestroyDescriptor(this.hdrViews[i]);
                    Nri_DestroyTexture(this.hdrTargets[i]);
                }
                for (let i = 0; i < this.blurChain.length; i++) {
                    Nri_DestroyDescriptor(this.blurViews[i]);
                    Nri_DestroyDescriptor(this.blurStorageViews[i]);
                    Nri_DestroyTexture(this.blurChain[i]);
                }
                this.destroyDescriptor(this.shadowAttachment);
                this.destroyDescriptor(this.shadowMapView);
                this.destroyDescriptor(this.hdrDepthAttachment);
                this.destroyDescriptor(this.linearClamp);
                this.destroyDescriptor(this.linearWrap);
                this.destroyDescriptor(this.comparisonSampler);
                this.destroyTexture(this.shadowMap);
                this.destroyTexture(this.hdrDepth);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.indexBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.shadowPipeline);
                this.destroyPipeline(this.forwardPipeline);
                this.destroyPipeline(this.forwardBlendPipeline);
                this.destroyPipeline(this.thresholdPipeline);
                this.destroyPipeline(this.blurDownPipeline);
                this.destroyPipeline(this.blurUpPipeline);
                this.destroyPipeline(this.compositePipeline);
                this.destroyLayout(this.shadowLayout);
                this.destroyLayout(this.forwardLayout);
                this.destroyLayout(this.postLayout);
                this.destroyLayout(this.compositeLayout);
                this.destroyFence(this.graphicsFence);
                this.destroyFence(this.computeFence);
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

        destroyTexture(texture: NriTextureHandle | null) {
            if (texture) {
                Nri_DestroyTexture(texture);
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

        destroyFence(fence: NriFenceHandle | null) {
            if (fence) {
                Nri_DestroyFence(fence);
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const bloom = new AsyncComputeBloom(sample);
        // -async, -doublebuffer, -norotate: the settings' initial values; -benchmark: simulated at 60
        // frames per second whatever the frame rate, as the sample's --benchmark; -noUI: no overlay.
        Nri_AddExampleOption(sample, "-async");
        Nri_AddExampleOption(sample, "-doublebuffer");
        Nri_AddExampleOption(sample, "-norotate");
        Nri_AddExampleOption(sample, "-benchmark");
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-async") {
                bloom.asyncEnabled = true;
            } else if (arg == "-doublebuffer") {
                bloom.doubleBufferHdr = true;
            } else if (arg == "-norotate") {
                bloom.rotateShadows = false;
            } else if (arg == "-benchmark") {
                bloom.benchmark = true;
            } else if (arg == "-noUI") {
                bloom.noUI = true;
            }
        }
        return bloom.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return AsyncComputeBloomNri.main(argc, argv);
}

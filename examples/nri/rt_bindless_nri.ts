/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { perspProjD3DStyleReverse } from "../../core/matrix";
import { DonutFirstPersonCamera } from "../../core/donut_first_person_camera";
import { DonutSceneTextures } from "../../core/nri_donut_textures";
import { DonutBlit } from "../../core/nri_donut_blit";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriDonutAnimatedScene, NriDonutAnimatedSceneAccelStructs, NriPipeline, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriRayTracingPipelineDesc, NriSample, NriShaderTable, NriTexture } from "../../core/nri";

namespace RtBindlessNri {
    // rt_bindless, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut and
    // NVRHI: the same shaders (rt_bindless.hlsl's library, or with -rayQuery its compute shader), Donut's
    // skinning and blit shaders (as Donut compiles them), the scene loaded and animated as Donut's engine
    // does it (core/nri/nri_donut_scene.cpp's NriDonutAnimatedScene.load: the scene file's models and
    // node graph, skins and animations; core/nri_donut_textures.ts), its acceleration structures as
    // Donut builds them every frame, the constants filled as Donut fills them
    // (core/nri/nri_donut_constants.cpp), through the NRI calls core/nri/nri_interop.d.ts binds. This
    // example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no ray tracing (or ray queries), or
    // no shaders for the graphics API (D3D11).
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Bindless Ray Tracing";
    const DEFAULT_SCENE = "media/sponza-plus.scene.json";

    // sizeof(RayPayload) in rt_bindless.hlsl: 6 floats / uints; the triangles' float2 barycentrics.
    const PAYLOAD_SIZE = 6 * 4;
    const ATTRIBUTE_SIZE = 8;
    // main in rt_bindless.hlsl (the ray query version) runs 16 x 16 threads per group; Donut's
    // skinning shader 256 x 1.
    const COMPUTE_GROUP_SIZE = 16;
    const SKINNING_GROUP_SIZE = 256;
    // SkinningConstants (skinning_cb.h): 15 uints.
    const SKINNING_CONSTANTS_WORDS = 15;
    // A float4x4.
    const JOINT_MATRIX_SIZE = 64;

    // The sun (Donut_AddDirectionalLight's arguments in the Donut example), the ambient color.
    const SUN_DIRECTION = [0.1, -1.0, -0.15];
    const SUN_ANGULAR_SIZE = 0.53;
    const SUN_IRRADIANCE = 5.0;
    const AMBIENT = 0.05;

    // The Donut example's camera: Donut's FirstPersonCamera at eye height looking along x, moving 3
    // units a second; reversed depth from 0.1, a 45 degree field of view.
    const MOVE_SPEED = 3.0;
    const ROTATE_SPEED = 0.005;
    const Z_NEAR = 0.1;

    // The bindless buffers (GeometryData's vertexBufferIndex, indexBufferIndex): the scene's vertices
    // (and the skinned models' joint indices and weights), its indices, the skinned vertices.
    const BINDLESS_BUFFER_COUNT = 3;

    // Constant buffer views' and storage buffer views' alignment.
    const CONSTANTS_ALIGNMENT = 256;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // -test: checks the last frame, read back, as the Donut example does: Sponza and the character in
    // it, lit through bindless resources, about 63% lit.
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
        if (lit < 50.0 || lit > 78.0) {
            return `Lit: ${lit}% of the pixels, not 50% to 78%`;
        }
        return "";
    }

    function align(size: int, alignment: int) {
        return Math.floor((size + alignment - 1) / alignment) * alignment;
    }

    function gcd(a: int, b: int): int {
        let x = a;
        let y = b;
        while (y != 0) {
            const t = x % y;
            x = y;
            y = t;
        }
        return x;
    }

    // size rounded up to a multiple of both the views' alignment and stride (a view's offset must be
    // both: D3D12 counts structured views' starts in structures).
    function slotSize(size: int, stride: int) {
        const unit = Math.floor(CONSTANTS_ALIGNMENT / gcd(CONSTANTS_ALIGNMENT, stride)) * stride;
        return align(Math.max(size, 1), unit);
    }

    // An f32 array of n zeros.
    function zeros(n: int) {
        const values: f32[] = [];
        for (let i = 0; i < n; i++) {
            values.push(0.0);
        }
        return values;
    }

    // What a frame in flight records into, and its sets (its copies of the per-frame data: the
    // lighting constants and the instances in the trace's set, the joint matrices in the skinning
    // sets, one per skinned instance).
    class QueuedFrame {
        constructor(public commandBuffer: NriCommandBuffer,
            public traceSet: NriDescriptorSet, public skinningSets: NriDescriptorSet[]) {
        }
    }

    // Port of Donut-Samples' rt_bindless.cpp (as examples/rt_bindless.ts ports it) to NRI: ray traces
    // an animated scene (Sponza with two dancing robots), primary rays and sun shadows, reading all
    // geometry and textures through bindless resource arrays, with a ray tracing pipeline or, with
    // -rayQuery, inline ray queries in a compute shader; the result is blitted into the swap chain.
    // Every frame the animations pose the robots, Donut's skinning shader skins them, their BLASes are
    // built again and the TLAS is built. Space pauses the animations; WASD/QE and the left mouse button
    // move the camera (Donut's FirstPersonCamera).
    class RtBindless {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        // The swap chain textures' format (the readback's) and their views' (sRGB).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private viewFormat: NriFormat = NriFormat.Unknown;
        private queuedFrames: QueuedFrame[] = [];
        private width: int = 0;
        private height: int = 0;
        private test: boolean = false;
        private vulkan: boolean = false;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";
        scenePath: string = DEFAULT_SCENE;
        useRayQuery: boolean = false;

        // The animated scene and its static data (a Donut scene), its buffers and their views: the
        // bindless buffers (vertices, indices, the skinned vertices, also written by the skinning
        // shader), the GeometryData and MaterialConstants; its textures; its acceleration structures.
        private scene: NriDonutAnimatedScene | null = null;
        private vertexBuffer: NriBuffer | null = null;
        private indexBuffer: NriBuffer | null = null;
        private skinnedVertexBuffer: NriBuffer | null = null;
        private geometryBuffer: NriBuffer | null = null;
        private materialBuffer: NriBuffer | null = null;
        private bindlessViews: NriDescriptor[] = [];
        private skinnedStorageView: NriDescriptor | null = null;
        private geometryView: NriDescriptor | null = null;
        private materialView: NriDescriptor | null = null;
        private textures: DonutSceneTextures = new DonutSceneTextures();
        private accelStructs: NriDonutAnimatedSceneAccelStructs | null = null;
        private topLevelASView: NriDescriptor | null = null;
        private skinnedCount: int = 0;
        // The skinned vertices: in AccelerationStructureInput once skinned (the first skinning finds
        // them in Storage).
        private skinned: boolean = false;

        // The per-frame data: the lighting constants, the instances' InstanceData, the joint matrices
        // (host buffers, a slot per frame in flight, and per skinned instance), and their views.
        private constantBuffer: NriBuffer | null = null;
        private instanceBuffer: NriBuffer | null = null;
        private jointBuffer: NriBuffer | null = null;
        private perFrameViews: NriDescriptor[] = [];
        private constantsStride: int = 0;
        private instanceStride: int = 0;
        private jointStrides: int[] = [];
        private jointOffsets: int[] = [];
        private jointFrameStride: int = 0;

        // The shaded color (RGBA16F, written by the rays) and its state between frames.
        private colorBuffer: NriTexture | null = null;
        private colorBufferStorage: NriDescriptor | null = null;
        private colorBufferView: NriDescriptor | null = null;
        private colorBufferState: NriTextureState = NriTextureState.Storage;

        // The trace's layout (the ray tracing pipeline's, or the compute shader's) and pipeline, its
        // shader table; the skinning shader's; the blit.
        private traceLayout: NriPipelineLayout | null = null;
        private tracePipeline: NriPipeline | null = null;
        private shaderTable: NriShaderTable | null = null;
        private skinningLayout: NriPipelineLayout | null = null;
        private skinningPipeline: NriPipeline | null = null;
        private blit: DonutBlit = new DonutBlit();
        private blitSet: NriDescriptorSet | null = null;
        // CommonRenderPasses' anisotropic wrap sampler.
        private anisotropicWrap: NriDescriptor | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        // The bindless arrays' sets: one on Vulkan (the shader's set 1, bindings 0 and 1), the buffers'
        // and the textures' on D3D12 (spaces 1 and 2).
        private bindlessSets: NriDescriptorSet[] = [];

        private camera: DonutFirstPersonCamera = new DonutFirstPersonCamera(MOVE_SPEED, ROTATE_SPEED);
        private viewMatrix: f32[] = zeros(16);
        private projMatrix: f32[] = zeros(16);
        // LightingConstants (rt_bindless_lighting_cb.h): float4 ambientColor, LightConstants light,
        // PlanarViewConstants view.
        private lightingConstants: f32[] = [];
        private lightOffset: int = 4;
        private lightingViewOffset: int = 0;
        private skinningConstants: f32[] = zeros(SKINNING_CONSTANTS_WORDS);

        // The animations: running (Space pauses them), the time they run at, Space's last state.
        private enableAnimations: boolean = true;
        private wallclockTime: number = 0.0;
        private spaceDown: boolean = false;

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
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
            this.vulkan = graphicsAPI == NriGraphicsAPI.VK;

            // Swap chain: blitted into through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.viewFormat;

            // Ray tracing: D3D12 or Vulkan (the Donut example's shaders have no DXBC).
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "No D3D11 shaders (ray tracing needs D3D12 or Vulkan)";
                return 0;
            }
            if (!this.useRayQuery && device.isFeatureSupported(NriFeature.RayTracing) == 0) {
                this.unsupportedReason = "The graphics device does not support Ray Tracing Pipelines";
                return 0;
            }
            if (this.useRayQuery && device.isFeatureSupported(NriFeature.RayQuery) == 0) {
                this.unsupportedReason = "The graphics device does not support Ray Queries";
                return 0;
            }

            const folder = this.vulkan ? "spirv" : "dxil";
            if (!this.loadScene(device, folder) || !this.createLayouts(device) || !this.createPipelines(device, folder)
                || !this.blit.init(device, folder, viewFormat) || !this.createDescriptorSets(device, queuedFrameNum)) {
                return 0;
            }

            this.camera.lookAt(0.0, 1.8, 0.0, 1.0, 1.8, 0.0);

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The scene, as Donut's engine loads it, its buffers, its textures; its acceleration structures,
        // as Donut_CreateAnimatedSceneAccelStructs creates them; the shaded color.
        loadScene(device: NriDevice, folder: string) {
            const scene = NriDonutAnimatedScene.load(this.scenePath);
            this.scene = scene;
            if (!scene) {
                console.log(`Cannot load the scene ${this.scenePath}`);
                return false;
            }
            const sceneData = scene.getScene();
            this.skinnedCount = scene.getSkinnedInstanceCount();
            const vertexBuffer = device.createDonutSceneBuffer(this.queue, sceneData, 0);
            const indexBuffer = device.createDonutSceneBuffer(this.queue, sceneData, 1);
            const geometryBuffer = device.createDonutSceneBuffer(this.queue, sceneData, 3);
            const materialBuffer = device.createDonutSceneBuffer(this.queue, sceneData, 4);
            // (At least a structure: a scene without skinned instances still binds it.)
            const skinnedVertexBuffer = device.createAccelerationStructureInputStorageBuffer(this.queue,
                Math.max(scene.getSkinnedVertexBufferSize(), 16), 4);
            this.vertexBuffer = vertexBuffer;
            this.indexBuffer = indexBuffer;
            this.geometryBuffer = geometryBuffer;
            this.materialBuffer = materialBuffer;
            this.skinnedVertexBuffer = skinnedVertexBuffer;
            if (!vertexBuffer || !indexBuffer || !geometryBuffer || !materialBuffer || !skinnedVertexBuffer) {
                console.log("Cannot create the scene's buffers");
                return false;
            }
            const views = [
                vertexBuffer.createStructuredView(0),
                indexBuffer.createStructuredView(0),
                skinnedVertexBuffer.createStructuredView(0),
            ];
            for (const view of views) {
                if (!view) {
                    console.log("Cannot create the scene's buffer views");
                    return false;
                }
                this.bindlessViews.push(view);
            }
            this.skinnedStorageView = skinnedVertexBuffer.createStructuredView(1);
            this.geometryView = geometryBuffer.createStructuredView(0);
            this.materialView = materialBuffer.createStructuredView(0);
            if (!this.skinnedStorageView || !this.geometryView || !this.materialView) {
                console.log("Cannot create the scene's buffer views");
                return false;
            }

            const queuedFrameNum = this.sample.getQueuedFrameNum();
            const accelStructs = device.createDonutAnimatedSceneAccelStructs(this.queue, scene, queuedFrameNum);
            this.accelStructs = accelStructs;
            if (!accelStructs) {
                console.log("Cannot build the scene's acceleration structures");
                return false;
            }
            this.topLevelASView = accelStructs.getTopLevelAS().getTopLevelAccelerationStructure().createDescriptor();

            if (!this.createColorBuffer(device) || !this.topLevelASView) {
                console.log("Cannot create the color buffer");
                return false;
            }

            return this.textures.load(device, this.queue, sceneData, folder);
        }

        // The shaded color at the window's size (in Storage, as made) and its storage and texture views.
        createColorBuffer(device: NriDevice): boolean {
            const colorBuffer = device.createStorageTexture(this.queue, this.width, this.height, NriFormat.RGBA16_SFLOAT);
            this.colorBuffer = colorBuffer;
            this.colorBufferState = NriTextureState.Storage;
            if (!colorBuffer) {
                return false;
            }
            this.colorBufferStorage = colorBuffer.createStorageView(NriFormat.RGBA16_SFLOAT);
            this.colorBufferView = colorBuffer.createView(NriFormat.RGBA16_SFLOAT);
            return true;
        }

        destroyColorBuffer() {
            this.destroyDescriptor(this.colorBufferStorage);
            this.destroyDescriptor(this.colorBufferView);
            const colorBuffer = this.colorBuffer;
            if (colorBuffer) {
                colorBuffer.destroy();
            }
            this.colorBufferStorage = null;
            this.colorBufferView = null;
            this.colorBuffer = null;
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The window was resized (NriSample.useResizableWindow): once the GPU is done with them, the swap
        // chain and the shaded color made again at its size, every frame's trace set and the blit's
        // set pointed at the new color. (Only once initialize got that far: the color exists.)
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
            if (!this.colorBuffer) {
                return;
            }
            this.destroyColorBuffer();
            if (!this.createColorBuffer(device)) {
                return;
            }
            const colorBufferStorage = this.colorBufferStorage;
            const colorBufferView = this.colorBufferView;
            if (!colorBufferStorage || !colorBufferView) {
                return;
            }
            for (const queuedFrame of this.queuedFrames) {
                queuedFrame.traceSet.updateDescriptor(4, 0, colorBufferStorage);
            }
            const blitSet = this.blitSet;
            if (blitSet) {
                blitSet.updateDescriptor(0, 0, colorBufferView);
            }
        }

        // The trace's layout, as rt_bindless.hlsl declares its bindings: set 0 the lighting constants
        // (b0), the scene (t0), the instances, geometries and materials (t1 to t3), the materials'
        // sampler (s0), the shaded color (u0); the bindless arrays (Vulkan: set 1, the buffers at
        // binding 0 and the textures at 1; D3D12: spaces 1 and 2). The skinning shader's
        // (skinning_cs.hlsl): set 0 the source vertices and the joint matrices (t0, t1), the skinned
        // vertices (u0); its SkinningConstants (b0) as root constants.
        createLayouts(device: NriDevice) {
            const stages = this.useRayQuery ? NriStage.Compute : NriStage.RayTracing;
            const textureCount = this.textures.views.length;
            const traceDesc = NriPipelineLayoutDesc.create();
            traceDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, stages, NriRangeFlags.None);
            traceDesc.addRange(0, 0, 1, NriDescriptorType.AccelerationStructure, stages, NriRangeFlags.None);
            traceDesc.addRange(0, 1, 3, NriDescriptorType.StructuredBuffer, stages, NriRangeFlags.None);
            traceDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, stages, NriRangeFlags.None);
            traceDesc.addRange(0, 0, 1, NriDescriptorType.StorageTexture, stages, NriRangeFlags.None);
            const arrayFlags = NriRangeFlags.PartiallyBound | NriRangeFlags.Array;
            traceDesc.addRange(1, 0, BINDLESS_BUFFER_COUNT, NriDescriptorType.StructuredBuffer, stages, arrayFlags);
            if (this.vulkan) {
                traceDesc.addRange(1, 1, textureCount, NriDescriptorType.Texture, stages, arrayFlags);
            } else {
                traceDesc.addRange(2, 0, textureCount, NriDescriptorType.Texture, stages, arrayFlags);
            }
            this.traceLayout = device.createPipelineLayoutFromDesc(traceDesc);
            traceDesc.destroy();

            const skinningDesc = NriPipelineLayoutDesc.create();
            skinningDesc.addRange(0, 0, 2, NriDescriptorType.StructuredBuffer, NriStage.Compute, NriRangeFlags.None);
            skinningDesc.addRange(0, 0, 1, NriDescriptorType.StorageStructuredBuffer, NriStage.Compute,
                NriRangeFlags.None);
            skinningDesc.addRootConstants(0, SKINNING_CONSTANTS_WORDS * 4, NriStage.Compute);
            this.skinningLayout = device.createPipelineLayoutFromDesc(skinningDesc);
            skinningDesc.destroy();

            if (!this.traceLayout || !this.skinningLayout) {
                console.log("Cannot create the pipeline layouts");
                return false;
            }
            return true;
        }

        // The trace's pipeline (the ray tracing pipeline of the ray generation shader, the miss shader
        // and the hit group of the closest hit and any hit shaders, its shader table: every geometry's
        // hits run the one hit group; or the ray query compute shader) and Donut's skinning shader's.
        createPipelines(device: NriDevice, folder: string) {
            const traceLayout = this.traceLayout;
            const skinningLayout = this.skinningLayout;
            if (!traceLayout || !skinningLayout) {
                return false;
            }
            const shaders = `shaders/rt_bindless/${folder}/rt_bindless.bin`;
            if (this.useRayQuery) {
                this.tracePipeline = device.createComputePipelinePermutation(traceLayout, shaders, "main", "USE_RAY_QUERY=1");
                if (!this.tracePipeline) {
                    console.log("Cannot create the ray query pipeline");
                    return false;
                }
            } else {
                const desc = NriRayTracingPipelineDesc.create();
                const raygenGroup = desc.addGroup(
                    desc.addShader(NriStage.RayGen, "RayGen"), -1, -1);
                const missGroup = desc.addGroup(desc.addShader(NriStage.Miss, "Miss"), -1, -1);
                const closestHit = desc.addShader(NriStage.ClosestHit, "ClosestHit");
                const anyHit = desc.addShader(NriStage.AnyHit, "AnyHit");
                const hitGroup = desc.addGroup(closestHit, anyHit, -1);
                const pipeline = device.createRayTracingPipelineFromDescPermutation(traceLayout, shaders, "USE_RAY_QUERY=0", desc,
                    PAYLOAD_SIZE, ATTRIBUTE_SIZE, 1);
                desc.destroy();
                this.tracePipeline = pipeline;
                if (!pipeline) {
                    console.log("Cannot create the ray tracing pipeline");
                    return false;
                }
                const missGroups: int[] = [missGroup];
                const hitGroups: int[] = [hitGroup];
                this.shaderTable = device.createShaderTableFromGroups(this.queue, pipeline, raygenGroup, Ref(missGroups[0]), 1,
                    Ref(hitGroups[0]), 1);
                if (!this.shaderTable) {
                    console.log("Cannot create the shader table");
                    return false;
                }
            }

            this.skinningPipeline = device.createComputePipeline(skinningLayout, `shaders/framework/${folder}/skinning_cs.bin`, "main");
            if (!this.skinningPipeline) {
                console.log("Cannot load Donut's skinning shader");
                return false;
            }
            return true;
        }

        // A view kept for destruction (null passes through).
        keepView(view: NriDescriptor | null): NriDescriptor | null {
            if (view) {
                this.perFrameViews.push(view);
            }
            return view;
        }

        // The sampler; the per-frame buffers (a slot per frame in flight); the queued frames and their
        // sets (the trace's, the skinning's per skinned instance); the bindless arrays' sets, the blits'.
        createDescriptorSets(device: NriDevice, queuedFrameNum: int) {
            const scene = this.scene;
            const traceLayout = this.traceLayout;
            const skinningLayout = this.skinningLayout;
            const topLevelASView = this.topLevelASView;
            const colorBufferStorage = this.colorBufferStorage;
            const colorBufferView = this.colorBufferView;
            const geometryView = this.geometryView;
            const materialView = this.materialView;
            const skinnedStorageView = this.skinnedStorageView;
            if (!scene || !traceLayout || !skinningLayout || !topLevelASView || !colorBufferStorage || !colorBufferView) {
                return false;
            }
            if (!geometryView || !materialView || !skinnedStorageView) {
                return false;
            }
            const anisotropicWrap = device.createSampler(NriFilter.Linear, NriAddressMode.Repeat, 16);
            this.anisotropicWrap = anisotropicWrap;

            // The lighting constants: the sun's LightConstants and the ambient color don't change.
            const viewSize = Nri.getDonutConstantsSize(0);
            const lightSize = Nri.getDonutConstantsSize(2);
            this.lightingViewOffset = this.lightOffset + lightSize / 4;
            this.lightingConstants = zeros(this.lightingViewOffset + viewSize / 4);
            for (let i = 0; i < 4; i++) {
                this.lightingConstants[i] = AMBIENT;
            }
            Nri.fillDonutDirectionalLightConstants(SUN_DIRECTION[0], SUN_DIRECTION[1], SUN_DIRECTION[2], SUN_ANGULAR_SIZE, SUN_IRRADIANCE,
                Ref(this.lightingConstants[this.lightOffset]));
            this.constantsStride = align(this.lightingConstants.length * 4, CONSTANTS_ALIGNMENT);
            const constantBuffer = device.createHostBuffer(queuedFrameNum * this.constantsStride, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;

            // The instances (StructuredBuffer<InstanceData>), the joint matrices (ByteAddressBuffer:
            // 4-byte structures).
            const instanceDataStride = scene.getInstanceDataStride();
            const instanceDataSize = scene.getInstanceDataSize();
            this.instanceStride = slotSize(instanceDataSize, instanceDataStride);
            const instanceBuffer = device.createHostBufferWithStride(queuedFrameNum * this.instanceStride, NriBufferUsage.StructuredBuffer,
                instanceDataStride);
            this.instanceBuffer = instanceBuffer;
            let jointFrameStride = 0;
            for (let k = 0; k < this.skinnedCount; k++) {
                const stride = slotSize(scene.getSkinnedJointCount(k) * JOINT_MATRIX_SIZE, 4);
                this.jointOffsets.push(jointFrameStride);
                this.jointStrides.push(stride);
                jointFrameStride += stride;
            }
            this.jointFrameStride = Math.max(jointFrameStride, CONSTANTS_ALIGNMENT);
            const jointBuffer = device.createHostBufferWithStride(queuedFrameNum * this.jointFrameStride, NriBufferUsage.StructuredBuffer, 4);
            this.jointBuffer = jointBuffer;

            const textureCount = this.textures.views.length;
            const blitCount = this.textures.blitSetCount();
            const skinningSetCount = queuedFrameNum * this.skinnedCount;
            const descriptorPool = device.createDescriptorPoolWithAccelerationStructuresAndStorageBuffers(
                queuedFrameNum + 2 + skinningSetCount + 1 + blitCount,
                queuedFrameNum + 1 + blitCount,
                queuedFrameNum,
                textureCount + 1 + blitCount,
                queuedFrameNum,
                3 * queuedFrameNum + BINDLESS_BUFFER_COUNT + 2 * skinningSetCount,
                skinningSetCount,
                queuedFrameNum);
            this.descriptorPool = descriptorPool;
            if (!constantBuffer || !instanceBuffer || !jointBuffer || !descriptorPool || !anisotropicWrap) {
                console.log("Cannot create the descriptors");
                return false;
            }

            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const traceSet = descriptorPool.allocateDescriptorSet(traceLayout, 0, 0);
                const constantsView = this.keepView(constantBuffer.createConstantView(i * this.constantsStride, this.constantsStride));
                const instanceView = this.keepView(instanceBuffer.createStructuredRangeView(i * this.instanceStride,
                    this.instanceStride, 0));
                if (!traceSet || !constantsView || !instanceView) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                traceSet.updateDescriptor(0, 0, constantsView);
                traceSet.updateDescriptor(1, 0, topLevelASView);
                traceSet.updateDescriptor(2, 0, instanceView);
                traceSet.updateDescriptor(2, 1, geometryView);
                traceSet.updateDescriptor(2, 2, materialView);
                traceSet.updateDescriptor(3, 0, anisotropicWrap);
                traceSet.updateDescriptor(4, 0, colorBufferStorage);

                // A skinned instance's set: the scene's vertices, its joint matrices, the skinned vertices.
                const skinningSets: NriDescriptorSet[] = [];
                for (let k = 0; k < this.skinnedCount; k++) {
                    const set = descriptorPool.allocateDescriptorSet(skinningLayout, 0, 0);
                    const jointView = this.keepView(jointBuffer.createStructuredRangeView(
                        i * this.jointFrameStride + this.jointOffsets[k], this.jointStrides[k], 0));
                    if (!set || !jointView) {
                        console.log("Cannot create the descriptor sets");
                        return false;
                    }
                    set.updateDescriptor(0, 0, this.bindlessViews[0]);
                    set.updateDescriptor(0, 1, jointView);
                    set.updateDescriptor(1, 0, skinnedStorageView);
                    skinningSets.push(set);
                }
                this.queuedFrames.push(new QueuedFrame(new NriCommandBuffer(this.frames.commandBuffer(i).handle), traceSet, skinningSets));
            }

            // The bindless arrays: the buffers by GeometryData's numbers; the textures by number.
            const bufferSet = descriptorPool.allocateDescriptorSet(traceLayout, 1, 0);
            if (!bufferSet) {
                console.log("Cannot create the descriptor sets");
                return false;
            }
            this.bindlessSets.push(bufferSet);
            for (let b = 0; b < BINDLESS_BUFFER_COUNT; b++) {
                bufferSet.updateDescriptor(0, b, this.bindlessViews[b]);
            }
            let textureSet = bufferSet;
            let textureRange = 1;
            if (!this.vulkan) {
                const set = descriptorPool.allocateDescriptorSet(traceLayout, 2, 0);
                if (!set) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                this.bindlessSets.push(set);
                textureSet = set;
                textureRange = 0;
            }
            for (let t = 0; t < textureCount; t++) {
                textureSet.updateDescriptor(textureRange, t, this.textures.views[t]);
            }

            this.blitSet = this.blit.createSet(descriptorPool, colorBufferView);
            if (!this.blitSet || !this.textures.createBlits(descriptorPool)) {
                console.log("Cannot create the descriptor sets");
                return false;
            }
            return true;
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The Donut example's onAnimate: the camera (unless in test mode, where nothing moves it), Space
        // pausing the animations, and the animations at the wall clock time, each a second after the
        // previous one. True if they posed the scene.
        animate(): boolean {
            // Donut's test mode animates every frame by 1/60 s (a float).
            const elapsedSeconds = this.test ? Math.fround(1.0 / 60.0) : this.sample.getFrameTime();
            if (!this.test) {
                this.camera.animate(this.sample, elapsedSeconds, true);
                const spaceDown = this.sample.isKeyPressed(NriKey.Space) != 0;
                if (spaceDown && !this.spaceDown) {
                    this.enableAnimations = !this.enableAnimations;
                }
                this.spaceDown = spaceDown;
            }
            const scene = this.scene;
            if (!scene || !this.enableAnimations) {
                return false;
            }
            this.wallclockTime += elapsedSeconds;
            let offset = 0.0;
            const animationCount = scene.getAnimationCount();
            for (let i = 0; i < animationCount; i++) {
                const duration = scene.getAnimationDuration(i);
                const cycles = (this.wallclockTime + offset) / duration;
                const animationTime = (cycles - Math.floor(cycles)) * duration;
                scene.applyAnimation(i, animationTime);
                offset += 1.0;
            }
            return true;
        }

        // The queued frame's per-frame data: the scene refreshed (Scene::Refresh: transforms, instances,
        // joint matrices), its InstanceData and joint matrices, the LightingConstants of the view.
        writeFrameData(queuedFrameIndex: int) {
            const scene = this.scene;
            const constantBuffer = this.constantBuffer;
            const instanceBuffer = this.instanceBuffer;
            const jointBuffer = this.jointBuffer;
            if (!scene || !constantBuffer || !instanceBuffer || !jointBuffer) {
                return;
            }
            scene.refresh();
            scene.writeInstances(instanceBuffer, queuedFrameIndex * this.instanceStride);
            for (let k = 0; k < this.skinnedCount; k++) {
                scene.writeSkinnedJoints(k, jointBuffer, queuedFrameIndex * this.jointFrameStride + this.jointOffsets[k]);
            }

            const worldToView = this.camera.worldToView();
            const projection = perspProjD3DStyleReverse(Math.PI * 0.25, this.width / this.height, Z_NEAR);
            for (let i = 0; i < 16; i++) {
                this.viewMatrix[i] = worldToView[i];
                this.projMatrix[i] = projection[i];
            }
            Nri.fillDonutPlanarViewConstants(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), this.width, this.height,
                Ref(this.lightingConstants[this.lightingViewOffset]));
            constantBuffer.write(queuedFrameIndex * this.constantsStride, Ref(this.lightingConstants[0]),
                this.lightingConstants.length * 4);
        }

        // Scene::UpdateSkinnedMeshes: each skinned instance's vertices skinned by Donut's skinning shader
        // into the skinned vertex buffer, which the BLAS builds and the trace then read.
        recordSkinning(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const scene = this.scene;
            const layout = this.skinningLayout;
            const pipeline = this.skinningPipeline;
            const skinnedVertexBuffer = this.skinnedVertexBuffer;
            if (!scene || !layout || !pipeline || !skinnedVertexBuffer || this.skinnedCount == 0) {
                return;
            }
            if (this.skinned) {
                commandBuffer.bufferBarrier(skinnedVertexBuffer, NriBufferState.AccelerationStructureInput, NriBufferState.Storage);
            }
            commandBuffer.setComputePipelineLayout(layout);
            commandBuffer.setPipeline(pipeline);
            for (let k = 0; k < this.skinnedCount; k++) {
                scene.getSkinningConstants(k, Ref(this.skinningConstants[0]));
                commandBuffer.setComputeDescriptorSet(0, queuedFrame.skinningSets[k]);
                commandBuffer.setComputeRootConstants(0, Ref(this.skinningConstants[0]), SKINNING_CONSTANTS_WORDS * 4);
                const vertexCount = scene.getSkinnedVertexCount(k);
                commandBuffer.dispatch(Math.floor((vertexCount + SKINNING_GROUP_SIZE - 1) / SKINNING_GROUP_SIZE), 1, 1);
            }
            commandBuffer.bufferBarrier(skinnedVertexBuffer, NriBufferState.Storage, NriBufferState.AccelerationStructureInput);
            this.skinned = true;
        }

        // The rays (or ray queries): per pixel a primary ray and a shadow ray towards the sun, shading
        // the pixel into the shaded color, which then goes to the blit.
        recordTrace(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const colorBuffer = this.colorBuffer;
            const layout = this.traceLayout;
            const pipeline = this.tracePipeline;
            if (!colorBuffer || !layout || !pipeline) {
                return;
            }
            if (this.useRayQuery) {
                if (this.colorBufferState != NriTextureState.Storage) {
                    commandBuffer.textureBarrier(colorBuffer, this.colorBufferState, NriTextureState.Storage);
                }
                commandBuffer.setComputePipelineLayout(layout);
                commandBuffer.setPipeline(pipeline);
                commandBuffer.setComputeDescriptorSet(0, queuedFrame.traceSet);
                for (let k = 0; k < this.bindlessSets.length; k++) {
                    commandBuffer.setComputeDescriptorSet(1 + k, this.bindlessSets[k]);
                }
                const groupsX = Math.floor((this.width + COMPUTE_GROUP_SIZE - 1) / COMPUTE_GROUP_SIZE);
                const groupsY = Math.floor((this.height + COMPUTE_GROUP_SIZE - 1) / COMPUTE_GROUP_SIZE);
                commandBuffer.dispatch(groupsX, groupsY, 1);
                commandBuffer.textureBarrier(colorBuffer, NriTextureState.Storage, NriTextureState.ShaderResource);
            } else {
                const shaderTable = this.shaderTable;
                if (!shaderTable) {
                    return;
                }
                // (From its creation, a storage texture already: D3D12 wants the states to differ.)
                if (this.colorBufferState != NriTextureState.Storage) {
                    commandBuffer.textureBarrier(colorBuffer, this.colorBufferState, NriTextureState.RayTracingStorage);
                }
                commandBuffer.setRayTracingPipelineLayout(layout);
                commandBuffer.setPipeline(pipeline);
                commandBuffer.setRayTracingDescriptorSet(0, queuedFrame.traceSet);
                for (let k = 0; k < this.bindlessSets.length; k++) {
                    commandBuffer.setRayTracingDescriptorSet(1 + k, this.bindlessSets[k]);
                }
                commandBuffer.dispatchRays(shaderTable, this.width, this.height);
                commandBuffer.textureBarrier(colorBuffer, NriTextureState.RayTracingStorage, NriTextureState.ShaderResource);
            }
            this.colorBufferState = NriTextureState.ShaderResource;
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            const posed = this.animate();
            this.writeFrameData(queuedFrameIndex);

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                this.recordAndSubmit(frameIndex, queuedFrameIndex, queuedFrame, posed, index);
            }

            // Signaled after the present, as NRISamples do
            this.frames.signal(frameIndex);
        }

        // Records the frame into the queued frame's command buffer, submits it and presents: the mip
        // chains (the first frame), the skinning (when the animations posed the scene, and the first
        // frame), the acceleration structures (Donut_UpdateSceneAccelStructs), the trace, the blit.
        recordAndSubmit(frameIndex: int, queuedFrameIndex: int, queuedFrame: QueuedFrame, posed: boolean,
            index: int) {
            const descriptorPool = this.descriptorPool;
            const scene = this.scene;
            const accelStructs = this.accelStructs;
            const skinnedVertexBuffer = this.skinnedVertexBuffer;
            if (!descriptorPool || !scene || !accelStructs || !skinnedVertexBuffer) {
                return;
            }
            const commandBuffer = queuedFrame.commandBuffer;
            commandBuffer.begin();
            commandBuffer.setDescriptorPool(descriptorPool);
            this.textures.recordBlits(commandBuffer);

            const skin = posed || !this.skinned;
            if (skin) {
                this.recordSkinning(commandBuffer, queuedFrame);
            }
            commandBuffer.buildDonutAnimatedSceneAccelStructs(accelStructs, scene, skinnedVertexBuffer, queuedFrameIndex,
                skin && this.skinnedCount > 0 ? 1 : 0);
            this.recordTrace(commandBuffer, queuedFrame);

            commandBuffer.textureBarrier(this.swapChain.texture(index), NriTextureState.Undefined, NriTextureState.ColorAttachment);
            commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
            const blitSet = this.blitSet;
            if (blitSet) {
                this.blit.record(commandBuffer, blitSet, this.width, this.height);
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
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                for (const view of this.perFrameViews) {
                    view.destroy();
                }
                for (const view of this.bindlessViews) {
                    view.destroy();
                }
                this.destroyDescriptor(this.skinnedStorageView);
                this.destroyDescriptor(this.geometryView);
                this.destroyDescriptor(this.materialView);
                this.destroyDescriptor(this.anisotropicWrap);
                this.blit.destroy();
                this.textures.destroy();
                this.destroyColorBuffer();
                this.destroyDescriptor(this.topLevelASView);
                const accelStructs = this.accelStructs;
                if (accelStructs) {
                    accelStructs.destroy();
                }
                const shaderTable = this.shaderTable;
                if (shaderTable) {
                    shaderTable.destroy();
                }
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.indexBuffer);
                this.destroyBuffer(this.skinnedVertexBuffer);
                this.destroyBuffer(this.geometryBuffer);
                this.destroyBuffer(this.materialBuffer);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.instanceBuffer);
                this.destroyBuffer(this.jointBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.tracePipeline);
                this.destroyPipeline(this.skinningPipeline);
                this.destroyLayout(this.traceLayout);
                this.destroyLayout(this.skinningLayout);
                this.frames.destroy();
                this.swapChain.destroy();
                device.destroy();
            }
            const scene = this.scene;
            if (scene) {
                scene.destroy();
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
        const rtBindless = new RtBindless(sample);
        // --scene <path>: relative to the executable's directory. -rayQuery: inline ray queries in a
        // compute shader instead of a ray tracing pipeline. -noUI: accepted (the example has no UI).
        sample.addExampleOptionWithValues("--scene", 1);
        sample.addExampleOption("-rayQuery");
        sample.addExampleOption("-noUI");
        sample.useResizableWindow();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "--scene" && i + 1 < argc) {
                rtBindless.scenePath = Nri.getArg(argc, argv, i + 1);
            } else if (arg == "-rayQuery") {
                rtBindless.useRayQuery = true;
            }
        }
        return rtBindless.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return RtBindlessNri.main(argc, argv);
}

/// <reference path="../../core/nri/nri_interop.d.ts" />
import { radians, cross3, dot3 } from "../../core/matrix";
import { randomFloat } from "../../core/random";
import { DonutFirstPersonCamera } from "../../core/donut_first_person_camera";

namespace RayTracingInvocationReorderNri {
    // ray_tracing_invocation_reorder, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework
    // instead of Donut and NVRHI: the same shaders (ray_tracing_invocation_reorder.hlsl's library),
    // through the NRI calls core/nri/nri_interop.d.ts binds. This example creates everything it runs,
    // and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no ray tracing, or no shaders for
    // the graphics API (D3D11).
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Ray Tracing Invocation Reorder";

    // The sample's scene and flame texture (Vulkan-Samples' assets, ray_tracing_extended's), the KTX
    // textures converted to DDS at build time (see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt): the
    // glTF's <name>.ktx images are <name>.dds next to it.
    const SCENE_DIR = "media/ray_tracing_extended/sponza/";
    const SCENE_PATH = "media/ray_tracing_extended/sponza/Sponza01.gltf";
    const FLAME_TEXTURE_PATH = "media/ray_tracing_extended/generated_flame.dds";

    // struct Payload: three float4; the triangles' float2 barycentrics; primary rays traced by the ray
    // generation shader alone.
    const PAYLOAD_SIZE = 48;
    const ATTRIBUTE_SIZE = 8;

    // struct NewVertex: float3 pos, float3 normal, float2 tex_coord.
    const VERTEX_FLOATS = 8;
    const VERTEX_SIZE = 32;
    // Triangle: three uint32 indices.
    const TRIANGLE_SIZE = 12;

    // enum RenderMode (RENDER_BARYCENTRIC .. RenderMode.Ao in between).
    enum RenderMode {
        Default = 0,
        Ao = 6
    }

    // enum ObjectType
    enum ObjectType {
        Normal = 0, // has AO and ray traced shadows
        Refraction = 1, // pass-through with IOR
        Flame = 2 // emission surface; constant amplitude
    }

    // struct CameraProperties in shaders/ray_tracing_invocation_reorder.hlsl, as f32 offsets.
    const CONST_VIEW_INVERSE = 0;
    const CONST_PROJ_INVERSE = 16;
    const CONST_RENDER_MODE = 32;        // uint
    const CONST_MAX_RAYS = 33;           // uint
    const CONST_ENABLE_SER = 34;         // int
    const CONST_USE_COHERENCE_HINT = 35; // int
    const CONST_FLOATS = 36;
    // A constant buffer view's size is a multiple of 256 bytes (D3D12): a slice per frame in flight.
    const CONST_SLICE = 256;

    // The hit groups' closest hit shaders, by object type (the instances' hit group offsets), and
    // the pipeline's groups (Nri_RayTracingPipelineDescAddGroup's order): the ray generation shader,
    // the miss shader, then the hit groups.
    const CLOSEST_HITS = ["closesthit_normal", "closesthit_refraction", "closesthit_flame"];
    const RAYGEN_GROUP = 0;
    const MISS_GROUP = 1;
    const FIRST_HIT_GROUP = 2;

    // The sample's specialization constant maxRays.
    const MAX_RAYS = 60;
    // The refraction model's vertices per side.
    const GRID_SIZE = 100;
    const FLAME_PARTICLE_COUNT = 512;

    // nri::TopLevelInstanceBits::TRIANGLE_CULL_DISABLE (VK_GEOMETRY_INSTANCE_TRIANGLE_FACING_CULL_DISABLE_BIT_KHR).
    const INSTANCE_FLAGS_CULL_DISABLE = 1;

    // The sample's camera: glm::perspective(60 degrees, aspect, 0.1, 512), depth from 0 to 1.
    const FOV_DEGREES = 60.0;
    const Z_NEAR = 0.1;
    const Z_FAR = 512.0;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into: its constants' slice and the refraction model's vertices
    // (rewritten every frame), and the set binding them.
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public constantsView: NriDescriptorHandle | null, public dynamicVertexBuffer: NriBufferHandle | null,
            public dynamicVertexView: NriDescriptorHandle | null, public set: NriDescriptorSetHandle | null) {
        }
    }

    // A swap chain texture, its color attachment view (sRGB, for the UI) and the semaphores of its
    // acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // -test: checks the last frame, read back, as the Donut example does: the dark Sponza, about 22%
    // lit, and the fire's white in the middle (about 2% white).
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const total = width * height;
        if ((pixels[Math.floor(height / 2) * width + Math.floor(width / 2)] & 0xFFFFFF) != 0xFFFFFF) {
            return "the middle isn't the fire's white";
        }
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
        const lit = share(total - dark, total, 15.0, 30.0, "Lit");
        if (lit != "") {
            return lit;
        }
        return share(white, total, 1.0, 4.0, "White");
    }

    // core/test_check.ts' share: count is between `min` and `max` hundredths of `total` pixels.
    function share(count: int, total: int, min: number, max: number, what: string): string {
        const percent = 100.0 * count / total;
        console.log(`${what}: ${percent}% (${count} of ${total} pixels)`);
        if (percent < min || percent > max) {
            return `${what}: ${percent}% of the pixels, not ${min}% to ${max}%`;
        }
        return "";
    }

    // --- The sample's scene (core/ray_tracing_extended_scene.ts's, which the Donut ports share; its
    // ModelBuffer holds a Donut BLAS) -------------------------------------------------------------

    // glm::normalize: a zero vector gives NaNs, as there.
    function normalize(v: number[]) {
        const inverseLength = 1.0 / Math.sqrt(dot3(v, v));
        return [v[0] * inverseLength, v[1] * inverseLength, v[2] * inverseLength];
    }

    class FlameParticle {
        position: number[];
        velocity: number[];
        duration: number;

        constructor(position: number[], velocity: number[], duration: number) {
            this.position = position;
            this.velocity = velocity;
            this.duration = duration;
        }
    }

    class FlameParticleGenerator {
        particles: FlameParticle[];
        private origin: number[];
        private direction: number[];
        private u: number[];
        private v: number[];
        private lifetime: number;
        private radius: number;
        private nParticles: int;

        constructor(origin: number[], direction: number[], radius: number, nParticles: int) {
            this.particles = [];
            this.origin = origin;
            this.direction = direction;
            this.radius = radius;
            this.nParticles = nParticles;
            this.lifetime = 5.0;
            this.u = normalize(Math.abs(dot3(direction, [0.0, 0.0, 1.0])) > 0.9
                ? cross3(direction, [1.0, 0.0, 0.0]) : cross3(direction, [0.0, 0.0, 1.0]));
            this.v = normalize(cross3(direction, this.u));
        }

        generateRandomDirection() {
            const a = 0.2 * randomFloat();
            const b = 0.2 * randomFloat();
            const c = 0.8 * randomFloat();
            const u = this.u;
            const v = this.v;
            const d = this.direction;
            return normalize([a * u[0] + b * v[0] + c * d[0], a * u[1] + b * v[1] + c * d[1], a * u[2] + b * v[2] + c * d[2]]);
        }

        generateParticle(lifetime: number) {
            const theta = 2.0 * 3.14159 * randomFloat();
            const R = this.radius * randomFloat();
            const velocityDirection = this.generateRandomDirection();
            const speed = randomFloat() * 0.2;

            const s = Math.sin(theta);
            const c = Math.cos(theta);
            const position: number[] = [];
            const velocity: number[] = [];
            for (let i = 0; i < 3; i++) {
                position.push(this.origin[i] + R * (s * this.u[i] + c * this.v[i]));
                velocity.push(speed * velocityDirection[i]);
            }
            return new FlameParticle(position, velocity, lifetime);
        }

        // The sample's constructor's particles, at random points of their lifetimes.
        init() {
            for (let i = 0; i < this.nParticles; i++) {
                const startingLifetime = randomFloat() * this.lifetime;
                this.particles.push(this.generateParticle(startingLifetime));
            }
        }

        updateParticles(timeDelta: number) {
            const remaining = this.particles.filter((particle) => !(particle.duration > randomFloat() * this.lifetime));

            for (const particle of remaining) {
                for (let k = 0; k < 3; k++) {
                    particle.position[k] += timeDelta * particle.velocity[k];
                }
                particle.duration += timeDelta;
            }

            while (remaining.length < this.nParticles) {
                remaining.push(this.generateParticle(0.0));
            }
            this.particles = remaining;
        }
    }

    // Geometry in NewVertex layout, before it goes to the static buffers.
    class Model {
        vertices: f32[];
        triangles: int[];
        textureIndex: int;
        objectType: int;

        constructor(vertices: f32[], triangles: int[], textureIndex: int, objectType: int) {
            this.vertices = vertices;
            this.triangles = triangles;
            this.textureIndex = textureIndex;
            this.objectType = objectType;
        }
    }

    // A model's place in the static or dynamic buffers, and its BLAS (the refraction model's an
    // updatable one).
    class ModelBuffer {
        vertexOffset: int; // in bytes
        indexOffset: int;  // in bytes
        numVertices: int;
        numTriangles: int;
        textureIndex: int;
        objectType: int;
        isStatic: boolean;
        blas: NriAccelerationStructureHandle | null;

        constructor(vertexOffset: int, indexOffset: int, numVertices: int, numTriangles: int, textureIndex: int,
            objectType: int, isStatic: boolean) {
            this.vertexOffset = vertexOffset;
            this.indexOffset = indexOffset;
            this.numVertices = numVertices;
            this.numTriangles = numTriangles;
            this.textureIndex = textureIndex;
            this.objectType = objectType;
            this.isStatic = isStatic;
            this.blas = null;
        }
    }

    // --- The example ------------------------------------------------------------------------------

    // Port of Vulkan-Samples' ray_tracing_invocation_reorder, as examples/ray_tracing_invocation_reorder.ts
    // ports it, to NRI: ray_tracing_extended's scene (Sponza with ray traced shadows and ambient
    // occlusion, a refracting sheet whose BLAS is updated every frame, flame particles instanced in a
    // TLAS rebuilt every frame) with a hit group per material, which the instances select (their hit
    // group offsets), and Shader Execution Reordering: the primary rays are traced into hit objects,
    // the threads reordered by them (coherence hints: the instance hit) before their hit shaders run.
    // Where the device has no hit objects (D3D12 without shader model 6.9, which needs the Agility SDK
    // NRI is built without), the library without them traces as ray_tracing_extended does. Rays are
    // traced into a storage texture, copied to the back buffer, the UI drawn over it.
    class RayTracingInvocationReorder {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private layout: NriPipelineLayoutHandle | null = null;
        private pipeline: NriPipelineHandle | null = null;
        private shaderTable: NriShaderTableHandle | null = null;
        private camera: DonutFirstPersonCamera = new DonutFirstPersonCamera(1.0, radians(1.0));

        // The scene's textures (the bindless array's, by descriptor index) and their file names.
        private textures: NriTextureHandle[] = [];
        private textureViews: NriDescriptorHandle[] = [];
        private textureNames: string[] = [];
        private sampler: NriDescriptorHandle | null = null;

        private vertexBuffer: NriBufferHandle | null = null;
        private indexBuffer: NriBufferHandle | null = null;
        private dataToModelBuffer: NriBufferHandle | null = null;
        private dynamicIndexBuffer: NriBufferHandle | null = null;
        private vertexView: NriDescriptorHandle | null = null;
        private indexView: NriDescriptorHandle | null = null;
        private dataToModelView: NriDescriptorHandle | null = null;
        private dynamicIndexView: NriDescriptorHandle | null = null;
        private constantBuffer: NriBufferHandle | null = null;
        private refractionBlas: NriUpdatableBlasHandle | null = null;
        private topLevelAS: NriTopLevelASHandle | null = null;
        private topLevelASView: NriDescriptorHandle | null = null;
        private models: Model[] = [];
        private modelBuffers: ModelBuffer[] = [];
        private flameGenerator: FlameParticleGenerator;

        private output: NriTextureHandle | null = null;
        private outputStorage: NriDescriptorHandle | null = null;
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        // The swap chain textures' views for the UI: sRGB.
        private viewFormat: NriFormat = NriFormat.Unknown;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private textureSet: NriDescriptorSetHandle | null = null;
        // The output was copied from (after the first frame).
        private outputCopied: boolean = false;

        // Seconds since the start, for the refraction model's waves.
        private time: number = 0.0;
        private refractionModel: f32[] = [];
        private refractionIndices: int[] = [];
        // The CameraProperties contents.
        private constants: f32[] = [];
        // Donut's world-to-view matrix, 16 floats.
        private viewMatrix: f32[] = [];
        // The camera's position in the sample's world, from the view.
        private eye: number[] = [0.0, 0.0, 0.0];
        // An instance transform, 12 floats.
        private transform: f32[] = [];
        private width: int = 0;
        private height: int = 0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        // -mode <0..6>: the sample's render mode.
        renderMode: int = RenderMode.Default;
        // Whether the device has hit objects (NriFeature.ShaderExecutionReordering), and the sample's
        // settings (-noser, -nohint: off at start).
        serSupported: boolean = false;
        serEnabled: boolean = true;
        coherenceHintEnabled: boolean = true;
        // -noUI: no overlay.
        noUI: boolean = false;
        private imgui: boolean = false;

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.constants.push(0.0);
            }
            for (let i = 0; i < 16; i++) {
                this.viewMatrix.push(0.0);
            }
            for (let i = 0; i < 12; i++) {
                this.transform.push(0.0);
            }
            this.flameGenerator = new FlameParticleGenerator([-0.15, -1.5, -2.3], [0.0, -1.0, 0.0], 0.5, FLAME_PARTICLE_COUNT);
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
                const failure = checkFrame(this.readBack(), this.width, this.height);
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
            this.test = Nri_IsTest(this.sample) != 0;

            // Swap chain: copied into, in its own (UNORM) format: the shader writes the values the
            // sample's vkCmdCopyImage puts in its sRGB back buffer as they are.
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.createSwapChain(device);
            const format = this.swapChainFormat;

            // Ray tracing pipelines: D3D12 or Vulkan (the Donut example's shaders have no DXBC).
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "No D3D11 shaders (ray tracing needs D3D12 or Vulkan)";
                return 0;
            }
            if (Nri_IsFeatureSupported(device, NriFeature.RayTracing) == 0) {
                this.unsupportedReason = "The graphics device does not support Ray Tracing Pipelines";
                return 0;
            }

            if (!this.loadScene(device) || !this.createFlameModel(device)) {
                console.log("Cannot load the scene and its textures: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            const textureCount = this.textureViews.length;

            // The layout: set 0 the constants (b0), the scene (t0), the vertex, index, instance data,
            // dynamic vertex and dynamic index buffers (t1 to t5), the sampler (s0) and the output
            // (u0); set 1 the scene's textures (t0 in space 1; set 1's binding 0 on Vulkan), for every
            // ray tracing stage.
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.RayTracing, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.AccelerationStructure, NriStage.RayTracing, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 1, 5, NriDescriptorType.StructuredBuffer, NriStage.RayTracing, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.RayTracing, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.StorageTexture, NriStage.RayTracing, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 1, 0, textureCount, NriDescriptorType.Texture, NriStage.RayTracing,
                NriRangeFlags.PartiallyBound | NriRangeFlags.Array);
            const layout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            this.layout = layout;
            if (!layout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }
            // The ray generation and miss shaders, and a hit group per object type, from the library
            // with hit objects (SER=1: shader model 6.9 on D3D12, the NV extension on Vulkan) where the
            // device has them.
            this.serSupported = Nri_IsFeatureSupported(device, NriFeature.ShaderExecutionReordering) != 0;
            const desc = Nri_CreateRayTracingPipelineDesc();
            Nri_RayTracingPipelineDescAddGroup(desc, Nri_RayTracingPipelineDescAddShader(desc, NriStage.RayGen, "raygen"), -1, -1);
            Nri_RayTracingPipelineDescAddGroup(desc, Nri_RayTracingPipelineDescAddShader(desc, NriStage.Miss, "miss"), -1, -1);
            for (const closestHit of CLOSEST_HITS) {
                Nri_RayTracingPipelineDescAddGroup(desc, Nri_RayTracingPipelineDescAddShader(desc, NriStage.ClosestHit, closestHit), -1, -1);
            }
            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const pipeline = Nri_CreateRayTracingPipelineFromDescPermutation(device, layout,
                `shaders/ray_tracing_invocation_reorder/${folder}/ray_tracing_invocation_reorder.bin`, this.serSupported ? "SER=1" : "SER=0",
                desc, PAYLOAD_SIZE, ATTRIBUTE_SIZE, 1);
            Nri_DestroyRayTracingPipelineDesc(desc);
            this.pipeline = pipeline;
            if (!pipeline) {
                console.log("Cannot initialize the ray tracing pipeline");
                return 0;
            }
            const missGroups: int[] = [MISS_GROUP];
            const hitGroups: int[] = [];
            for (let i = 0; i < CLOSEST_HITS.length; i++) {
                hitGroups.push(FIRST_HIT_GROUP + i);
            }
            this.shaderTable = Nri_CreateShaderTableFromGroups(device, this.queue, pipeline, RAYGEN_GROUP, Ref(missGroups[0]), missGroups.length,
                Ref(hitGroups[0]), hitGroups.length);
            if (!this.shaderTable) {
                console.log("Cannot create the shader table");
                return 0;
            }

            // The refraction model's vertices, one buffer per frame in flight (rewritten every frame).
            const gridVertices = GRID_SIZE * GRID_SIZE;
            const gridTriangles = 2 * GRID_SIZE * GRID_SIZE;
            const constantBuffer = Nri_CreateHostBuffer(device, CONST_SLICE * queuedFrameNum, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            if (!constantBuffer) {
                console.log("Cannot create the constant buffer");
                return 0;
            }
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const constantsView = Nri_CreateConstantBufferView(constantBuffer, i * CONST_SLICE, CONST_SLICE);
                const dynamicVertexBuffer = Nri_CreateHostBufferWithStride(device, gridVertices * VERTEX_SIZE,
                    NriBufferUsage.AccelerationStructureInput, 16);
                let dynamicVertexView: NriDescriptorHandle | null = null;
                if (dynamicVertexBuffer) {
                    dynamicVertexView = Nri_CreateStructuredBufferView(dynamicVertexBuffer, 0);
                }
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), constantsView,
                    dynamicVertexBuffer, dynamicVertexView, null));
                if (!constantsView || !dynamicVertexView) {
                    console.log("Cannot create the dynamic buffers");
                    return 0;
                }
            }

            if (!this.createBuffersAndBlases(device, gridVertices, gridTriangles)) {
                return 0;
            }

            // Every model but the flame once, and each flame particle.
            const topLevelAS = Nri_CreateTopLevelAS(device, this.modelBuffers.length - 1 + FLAME_PARTICLE_COUNT,
                NriAccelerationStructureFlags.None, queuedFrameNum);
            this.topLevelAS = topLevelAS;
            if (!topLevelAS) {
                console.log("Cannot create the top level acceleration structure");
                return 0;
            }
            const topLevelASView = Nri_CreateAccelerationStructureDescriptor(Nri_GetTopLevelAccelerationStructure(topLevelAS));
            this.topLevelASView = topLevelASView;

            // The output the ray generation shader writes: UNORM, in the back buffer's format, for the
            // copy.
            this.createOutput(device);
            const output = this.output;
            // CommonSampler.LinearWrap: linear, mips too, wrapped.
            const sampler = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.Repeat, 1);
            this.sampler = sampler;
            const descriptorPool = Nri_CreateDescriptorPoolWithAccelerationStructures(device, queuedFrameNum + 1, queuedFrameNum,
                queuedFrameNum, textureCount, queuedFrameNum, 5 * queuedFrameNum, queuedFrameNum);
            this.descriptorPool = descriptorPool;
            const vertexView = this.vertexView;
            const indexView = this.indexView;
            const dataToModelView = this.dataToModelView;
            const dynamicIndexView = this.dynamicIndexView;
            if (!output || !sampler || !descriptorPool || !topLevelASView || !vertexView || !indexView || !dataToModelView
                || !dynamicIndexView) {
                console.log("Cannot create the output");
                return 0;
            }
            const outputStorage = this.outputStorage;
            if (!outputStorage) {
                console.log("Cannot create the output");
                return 0;
            }

            for (const queuedFrame of this.queuedFrames) {
                const set = Nri_AllocateDescriptorSet(descriptorPool, layout, 0, 0);
                queuedFrame.set = set;
                const constantsView = queuedFrame.constantsView;
                const dynamicVertexView = queuedFrame.dynamicVertexView;
                if (!set || !constantsView || !dynamicVertexView) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(set, 0, 0, constantsView);
                Nri_UpdateDescriptor(set, 1, 0, topLevelASView);
                Nri_UpdateDescriptor(set, 2, 0, vertexView);
                Nri_UpdateDescriptor(set, 2, 1, indexView);
                Nri_UpdateDescriptor(set, 2, 2, dataToModelView);
                Nri_UpdateDescriptor(set, 2, 3, dynamicVertexView);
                Nri_UpdateDescriptor(set, 2, 4, dynamicIndexView);
                Nri_UpdateDescriptor(set, 3, 0, sampler);
                Nri_UpdateDescriptor(set, 4, 0, outputStorage);
            }
            const textureSet = Nri_AllocateDescriptorSet(descriptorPool, layout, 1, 0);
            this.textureSet = textureSet;
            if (!textureSet) {
                console.log("Cannot create the texture set");
                return 0;
            }
            for (let t = 0; t < textureCount; t++) {
                Nri_UpdateDescriptor(textureSet, 0, t, this.textureViews[t]);
            }

            // The sample's first person camera at (0, 1.5, 0), not turned: at (0, -1.5, 0) looking
            // down -z in its world, (0, 1.5, 0) in Donut's (see updateUniformBuffers). One degree per
            // pixel of mouse movement and one unit per second, as its camera.
            this.camera.lookAt(0.0, 1.5, 0.0, 0.0, 1.5, -1.0);

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

        // The index of the bindless texture from the DDS file at path (sRGB), loaded the first time
        // it's asked for (Donut's texture cache gives the file's texture again); -1 on failure.
        loadTexture(device: NriDeviceHandle, path: string): int {
            for (let t = 0; t < this.textureNames.length; t++) {
                if (this.textureNames[t] == path) {
                    return t;
                }
            }
            const texture = Nri_LoadDdsTexture(device, this.queue, path, 1);
            if (!texture) {
                return -1;
            }
            this.textures.push(texture);
            this.textureViews.push(Nri_CreateTextureView(texture, Nri_GetTextureFormat(texture)));
            this.textureNames.push(path);
            return this.textures.length - 1;
        }

        // The sample's RaytracingScene: every Sponza submesh, its positions scaled to meters and its
        // axes turned (the vase moved too), with its base color texture. False on failure.
        loadScene(device: NriDeviceHandle): boolean {
            const scene = Nri_LoadGltfModel(SCENE_PATH);
            if (!scene) {
                return false;
            }

            const sponzaScale = 0.01;
            let loaded = true;
            for (let p = 0; p < Nri_GetGltfModelPrimitiveCount(scene); p++) {
                const image = Nri_GetGltfModelBaseColorImage(scene, p);
                if (!image.endsWith(".ktx")) {
                    console.log(`Unexpected base color image ${image} in ${SCENE_PATH}`);
                    loaded = false;
                    break;
                }
                const textureIndex = this.loadTexture(device, SCENE_DIR + image.substring(0, image.length - 4) + ".dds");
                if (textureIndex < 0) {
                    loaded = false;
                    break;
                }
                const isVase = image.indexOf("vase_dif.ktx") >= 0;

                const vertexCount = Nri_GetGltfModelVertexCount(scene, p);
                const indexCount = Nri_GetGltfModelIndexCount(scene, p);
                const vertices: f32[] = [];
                for (let i = 0; i < vertexCount * VERTEX_FLOATS; i++) {
                    vertices.push(0.0);
                }
                const triangles: int[] = [];
                for (let i = 0; i < indexCount; i++) {
                    triangles.push(0);
                }
                Nri_CopyGltfModelVertices(scene, p, Ref(vertices[0]));
                Nri_CopyGltfModelIndices(scene, p, Ref(triangles[0]));

                // pt = vec3(mat4(transform) * vec4(pt, 1)) + translation, with the sample's
                // column-major transform (0, 0, s, tx | s, 0, 0, 0 | 0, s, 0, tz): (s y + tx, s z, s x + tz),
                // where the vase's translation is (4.3, 0, 9.5) and the rest's 0.
                const tx = isVase ? 4.3 : 0.0;
                const tz = isVase ? 9.5 : 0.0;
                for (let v = 0; v < vertexCount * VERTEX_FLOATS; v += VERTEX_FLOATS) {
                    const x = vertices[v];
                    const y = vertices[v + 1];
                    const z = vertices[v + 2];
                    vertices[v] = sponzaScale * y + tx;
                    vertices[v + 1] = sponzaScale * z;
                    vertices[v + 2] = sponzaScale * x + tz;
                }

                this.models.push(new Model(vertices, triangles, textureIndex, ObjectType.Normal));
            }
            Nri_DestroyGltfModel(scene);
            return loaded;
        }

        // The sample's create_flame_model: a unit square billboard with the flame texture.
        createFlameModel(device: NriDeviceHandle): boolean {
            const textureIndex = this.loadTexture(device, FLAME_TEXTURE_PATH);
            if (textureIndex < 0) {
                return false;
            }

            const pts = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]];
            const vertices: f32[] = [];
            for (const pt of pts) {
                // center the point
                vertices.push(pt[0] - 0.5);
                vertices.push(pt[1] - 0.5);
                vertices.push(pt[2]);
                vertices.push(0.0);
                vertices.push(0.0);
                vertices.push(1.0);
                vertices.push(pt[0]);
                vertices.push(1.0 - pt[1]);
            }
            const triangles: int[] = [0, 1, 2, 0, 2, 3];
            this.models.push(new Model(vertices, triangles, textureIndex, ObjectType.Flame));

            this.flameGenerator.init();
            return true;
        }

        // The refraction model: a GRID_SIZE x GRID_SIZE sheet with waves running along it, its
        // normals averaged from the faces'. As in the sample, its index array has room for
        // 2 x GRID_SIZE^2 triangles but uses 2 x (GRID_SIZE - 1)^2: the rest are (0, 0, 0).
        createDynamicObjectBuffers(time: number) {
            const model = this.refractionModel;
            const indices = this.refractionIndices;
            if (model.length == 0) {
                for (let i = 0; i < GRID_SIZE * GRID_SIZE * VERTEX_FLOATS; i++) {
                    model.push(0.0);
                }
                for (let i = 0; i < 2 * GRID_SIZE * GRID_SIZE * 3; i++) {
                    indices.push(0);
                }
            }

            for (let i = 0; i < GRID_SIZE; i++) {
                for (let j = 0; j < GRID_SIZE; j++) {
                    const x = i / GRID_SIZE;
                    const y = j / GRID_SIZE;
                    const lateralScale = Math.min(Math.min(Math.min(Math.min(x, 1 - x), y), 1 - y), 0.2) * 5.0;
                    const base = (GRID_SIZE * i + j) * VERTEX_FLOATS;
                    model[base + 0] = y - 0.5;
                    model[base + 1] = 2 * x - 1.0;
                    model[base + 2] = lateralScale * 0.025 * Math.cos(2 * 3.14159 * (4 * x + time / 2));
                    model[base + 3] = 0.0;
                    model[base + 4] = 0.0;
                    model[base + 5] = 0.0;
                    model[base + 6] = x;
                    model[base + 7] = y;

                    if (i + 1 < GRID_SIZE && j + 1 < GRID_SIZE) {
                        const t = 6 * (GRID_SIZE * i + j);
                        indices[t + 0] = i * GRID_SIZE + j;
                        indices[t + 1] = (i + 1) * GRID_SIZE + j;
                        indices[t + 2] = i * GRID_SIZE + j + 1;
                        indices[t + 3] = (i + 1) * GRID_SIZE + j;
                        indices[t + 4] = (i + 1) * GRID_SIZE + j + 1;
                        indices[t + 5] = i * GRID_SIZE + j + 1;
                    }
                }
            }

            for (let t = 0; t < indices.length; t += 3) {
                const a = indices[t] * VERTEX_FLOATS;
                const b = indices[t + 1] * VERTEX_FLOATS;
                const c = indices[t + 2] * VERTEX_FLOATS;
                const normal = normalize(cross3(
                    [model[b] - model[a], model[b + 1] - model[a + 1], model[b + 2] - model[a + 2]],
                    [model[c] - model[a], model[c + 1] - model[a + 1], model[c + 2] - model[a + 2]]));
                for (let k = 0; k < 3; k++) {
                    const v = indices[t + k] * VERTEX_FLOATS;
                    model[v + 3] += normal[0];
                    model[v + 4] += normal[1];
                    model[v + 5] += normal[2];
                }
            }

            for (let v = 0; v < GRID_SIZE * GRID_SIZE * VERTEX_FLOATS; v += VERTEX_FLOATS) {
                const normal = normalize([model[v + 3], model[v + 4], model[v + 5]]);
                model[v + 3] = normal[0];
                model[v + 4] = normal[1];
                model[v + 5] = normal[2];
            }
        }

        // The sample's create_static_object_buffers, create_dynamic_object_buffers(0) and
        // create_bottom_level_acceleration_structure: the models' vertices and triangles in one vertex
        // and one index buffer, the refraction model in its own pair (its vertices the queued
        // frames'), a BLAS for each (the static ones from the same positions and indices). False
        // (after printing why) on failure.
        createBuffersAndBlases(device: NriDeviceHandle, gridVertices: int, gridTriangles: int): boolean {
            const staticVertices: f32[] = [];
            const staticTriangles: int[] = [];
            for (const model of this.models) {
                const modelBuffer = new ModelBuffer(staticVertices.length / VERTEX_FLOATS * VERTEX_SIZE,
                    staticTriangles.length / 3 * TRIANGLE_SIZE, model.vertices.length / VERTEX_FLOATS,
                    model.triangles.length / 3, model.textureIndex, model.objectType, true);
                this.modelBuffers.push(modelBuffer);
                for (const vertex of model.vertices) {
                    staticVertices.push(vertex);
                }
                for (const triangle of model.triangles) {
                    staticTriangles.push(triangle);
                }
            }

            const vertexCount = staticVertices.length / VERTEX_FLOATS;
            const triangleCount = staticTriangles.length / 3;
            const vertexBuffer = Nri_CreateUploadedStructuredBuffer(device, this.queue, Ref(staticVertices[0]), vertexCount * VERTEX_SIZE, 16);
            const indexBuffer = Nri_CreateUploadedStructuredBufferFromInts(device, this.queue, Ref(staticTriangles[0]),
                triangleCount * TRIANGLE_SIZE, 4);
            this.vertexBuffer = vertexBuffer;
            this.indexBuffer = indexBuffer;
            if (!vertexBuffer || !indexBuffer) {
                console.log("Cannot create the vertex and index buffers");
                return false;
            }
            this.vertexView = Nri_CreateStructuredBufferView(vertexBuffer, 0);
            this.indexView = Nri_CreateStructuredBufferView(indexBuffer, 0);

            // The refraction model's buffers: its vertices rewritten every frame (into the queued
            // frame's buffer), its indices once (they don't change), as ints in floats' storage.
            this.createDynamicObjectBuffers(0.0);
            const dynamicIndexBuffer = Nri_CreateHostBufferWithStride(device, gridTriangles * TRIANGLE_SIZE,
                NriBufferUsage.AccelerationStructureInput, 4);
            this.dynamicIndexBuffer = dynamicIndexBuffer;
            const firstVertexBuffer = this.queuedFrames[0].dynamicVertexBuffer;
            if (!dynamicIndexBuffer || !firstVertexBuffer) {
                console.log("Cannot create the dynamic buffers");
                return false;
            }
            const indexBits: f32[] = [];
            for (let i = 0; i < gridTriangles * 3; i++) {
                indexBits.push(0.0);
                Nri_StoreInt32(Ref(indexBits[i]), this.refractionIndices[i]);
            }
            Nri_WriteBuffer(dynamicIndexBuffer, 0, Ref(indexBits[0]), gridTriangles * TRIANGLE_SIZE);
            Nri_WriteBuffer(firstVertexBuffer, 0, Ref(this.refractionModel[0]), gridVertices * VERTEX_SIZE);
            this.dynamicIndexView = Nri_CreateStructuredBufferView(dynamicIndexBuffer, 0);
            this.modelBuffers.push(new ModelBuffer(0, 0, gridVertices, gridTriangles, -1, ObjectType.Refraction, false));

            // Static objects prefer fast tracing; the refraction model fast builds and updates (built
            // now from the first frame's buffer, updated every frame).
            for (let i = 0; i < this.modelBuffers.length; i++) {
                const modelBuffer = this.modelBuffers[i];
                if (!modelBuffer.isStatic) {
                    const refractionBlas = Nri_CreateUpdatableTriangleBlas(device, modelBuffer.numVertices, VERTEX_SIZE,
                        modelBuffer.numTriangles * 3, NriAccelerationStructureFlags.AllowUpdate | NriAccelerationStructureFlags.PreferFastBuild);
                    this.refractionBlas = refractionBlas;
                    if (!refractionBlas
                        || Nri_BuildUpdatableBlasOnQueue(this.queue, refractionBlas, firstVertexBuffer, 0, dynamicIndexBuffer, 0) == 0) {
                        console.log("Cannot build the bottom level acceleration structures");
                        return false;
                    }
                    modelBuffer.blas = Nri_GetUpdatableBlasAccelerationStructure(refractionBlas);
                    continue;
                }
                // Its positions (the first 3 of each vertex's floats: the Donut example's BLAS reads
                // them VERTEX_SIZE bytes apart) and indices.
                const firstVertex = modelBuffer.vertexOffset / VERTEX_SIZE;
                const firstIndex = modelBuffer.indexOffset / 4;
                const positions: f32[] = [];
                for (let v = 0; v < modelBuffer.numVertices; v++) {
                    const base = (firstVertex + v) * VERTEX_FLOATS;
                    positions.push(staticVertices[base]);
                    positions.push(staticVertices[base + 1]);
                    positions.push(staticVertices[base + 2]);
                }
                const indices: int[] = [];
                for (let k = 0; k < modelBuffer.numTriangles * 3; k++) {
                    indices.push(staticTriangles[firstIndex + k]);
                }
                const desc = Nri_CreateBlasDesc();
                Nri_BlasDescAddTriangles(desc, Ref(positions[0]), modelBuffer.numVertices, Ref(indices[0]), indices.length);
                const blas = Nri_BuildBlasFromDesc(device, this.queue, desc, NriAccelerationStructureFlags.PreferFastTrace);
                Nri_DestroyBlasDesc(desc);
                modelBuffer.blas = blas;
                if (!blas) {
                    console.log("Cannot build the bottom level acceleration structures");
                    return false;
                }
            }

            // This buffer is used to correlate the instance information with model information:
            // struct SceneInstanceData { vertex_index, indices_index, image_index, object_type }.
            const modelInstanceData: int[] = [];
            for (const modelBuffer of this.modelBuffers) {
                modelInstanceData.push(modelBuffer.vertexOffset / VERTEX_SIZE);
                modelInstanceData.push(modelBuffer.indexOffset / TRIANGLE_SIZE);
                modelInstanceData.push(modelBuffer.textureIndex);
                modelInstanceData.push(modelBuffer.objectType);
            }
            const dataToModelBuffer = Nri_CreateUploadedStructuredBufferFromInts(device, this.queue, Ref(modelInstanceData[0]),
                modelInstanceData.length * 4, 4);
            this.dataToModelBuffer = dataToModelBuffer;
            if (!dataToModelBuffer) {
                console.log("Cannot create the instance data buffer");
                return false;
            }
            this.dataToModelView = Nri_CreateStructuredBufferView(dataToModelBuffer, 0);
            return true;
        }

        // Waits for the frame that last used this frame's command allocator (and its buffers).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The sample's calculate_rotation into this.transform: a billboard at pt facing the camera,
        // turned only around y if freezeY.
        calculateRotation(pt: number[], scale: number, freezeY: boolean) {
            let normal = normalize([pt[0] - this.eye[0], pt[1] - this.eye[1], pt[2] - this.eye[2]]);
            if (freezeY) {
                normal = normalize(Math.abs(normal[1]) > 0.99 ? [0.0, 0.0, 1.0] : [normal[0], 0.0, normal[2]]);
            }
            const u = normalize(cross3(normal, [0.0, 1.0, 0.0]));
            const v = normalize(cross3(normal, u));

            // wait to multiply by scale until after calculating basis to prevent floating point problems
            for (let row = 0; row < 3; row++) {
                this.transform[row * 4 + 0] = u[row] * scale;
                this.transform[row * 4 + 1] = v[row] * scale;
                this.transform[row * 4 + 2] = normal[row] * scale;
                this.transform[row * 4 + 3] = pt[row];
            }
        }

        // The sample's create_top_level_acceleration_structure: Sponza and the refraction model, then
        // a billboard instance per flame particle; built this frame (into the queued frame's instance
        // buffer).
        createTopLevelAccelerationStructure(commandBuffer: NriCommandBufferHandle, topLevelAS: NriTopLevelASHandle, queuedFrameIndex: int) {
            Nri_TopLevelASClearInstances(topLevelAS);
            let flameIndex = -1;
            for (let i = 0; i < this.modelBuffers.length; i++) {
                const modelBuffer = this.modelBuffers[i];
                // these objects have a single instance with the identity transform
                if (modelBuffer.objectType == ObjectType.Normal) {
                    for (let k = 0; k < 12; k++) {
                        this.transform[k] = k % 5 == 0 ? 1.0 : 0.0;
                    }
                } else if (modelBuffer.objectType == ObjectType.Refraction) {
                    this.calculateRotation([-0.25, -2.5, -2.35], 1.0, true);
                } else {
                    // handle flame separately
                    flameIndex = i;
                    continue;
                }
                const blas = modelBuffer.blas;
                // Use object_type to select the appropriate hit group shader
                // This creates shader divergence that SER can optimize by reordering threads
                if (blas) {
                    Nri_TopLevelASAddInstance(topLevelAS, blas, Ref(this.transform[0]), i, 0xFF, modelBuffer.objectType,
                        INSTANCE_FLAGS_CULL_DISABLE);
                }
            }

            // find the flame particle object, then add the particles as instances
            const flameBlas = this.modelBuffers[flameIndex].blas;
            if (flameBlas) {
                const particles = this.flameGenerator.particles;
                for (const particle of particles) {
                    this.calculateRotation(particle.position, 0.25, true);
                    Nri_TopLevelASAddInstance(topLevelAS, flameBlas, Ref(this.transform[0]), flameIndex, 0xFF, ObjectType.Flame,
                        INSTANCE_FLAGS_CULL_DISABLE);
                }
            }

            Nri_CmdBuildTopLevelAS(commandBuffer, topLevelAS, queuedFrameIndex, 0);
        }

        // The sample's update_uniform_buffers into this frame's slice: inverse view and projection
        // matrices.
        updateUniformBuffers(queuedFrameIndex: int) {
            const constantBuffer = this.constantBuffer;
            if (!constantBuffer) {
                return;
            }
            const worldToView = this.camera.worldToView();
            for (let i = 0; i < 16; i++) {
                this.viewMatrix[i] = worldToView[i];
            }

            // The sample's world has -y up on the screen. Mirrored in y it is Donut's world, y up,
            // with the same picture: Donut's world is right-handed, its view space left-handed. So
            // the sample's view matrix is the y mirror, then Donut's view, then Donut's view space
            // to the sample's (y down, -z forward): rows and columns of Donut's negated.
            const view: number[] = [];
            for (let i = 0; i < 16; i++) {
                const row = Math.floor(i / 4);
                const column = i % 4;
                const mirrored = row == 1 ? -this.viewMatrix[i] : this.viewMatrix[i];
                view.push(column == 1 || column == 2 ? -mirrored : mirrored);
            }

            // inverse(view): a rotation and a translation, so the rotation transposed and the
            // translation turned back. Its last row is the camera's position.
            const c = this.constants;
            for (let row = 0; row < 3; row++) {
                for (let column = 0; column < 3; column++) {
                    c[CONST_VIEW_INVERSE + row * 4 + column] = view[column * 4 + row];
                }
                c[CONST_VIEW_INVERSE + row * 4 + 3] = 0.0;
            }
            for (let column = 0; column < 3; column++) {
                let t = 0.0;
                for (let k = 0; k < 3; k++) {
                    t -= view[12 + k] * view[column * 4 + k];
                }
                c[CONST_VIEW_INVERSE + 12 + column] = t;
                this.eye[column] = t;
            }
            c[CONST_VIEW_INVERSE + 15] = 1.0;

            // inverse(glm::perspective(fov, aspect, near, far)) for row vectors.
            const tanHalfFovy = Math.tan(0.5 * radians(FOV_DEGREES));
            const aspect = this.width / this.height;
            const p22 = Z_FAR / (Z_NEAR - Z_FAR);
            const p32 = -(Z_FAR * Z_NEAR) / (Z_FAR - Z_NEAR);
            const projInverse = [
                aspect * tanHalfFovy, 0.0,         0.0,  0.0,
                0.0,                  tanHalfFovy, 0.0,  0.0,
                0.0,                  0.0,         0.0,  1.0 / p32,
                0.0,                  0.0,         -1.0, p22 / p32,
            ];
            for (let i = 0; i < 16; i++) {
                c[CONST_PROJ_INVERSE + i] = projInverse[i];
            }

            Nri_StoreInt32(Ref(c[CONST_RENDER_MODE]), this.renderMode);
            Nri_StoreInt32(Ref(c[CONST_MAX_RAYS]), MAX_RAYS);
            // SER only with the library that has it (see initialize).
            Nri_StoreInt32(Ref(c[CONST_ENABLE_SER]), this.serEnabled && this.serSupported ? 1 : 0);
            Nri_StoreInt32(Ref(c[CONST_USE_COHERENCE_HINT]), this.coherenceHintEnabled ? 1 : 0);
            Nri_WriteBuffer(constantBuffer, queuedFrameIndex * CONST_SLICE, Ref(c[0]), CONST_FLOATS * 4);
        }

        // The Donut example's onAnimate: the camera (Donut's FirstPersonCamera, unless in test mode,
        // where nothing moves it; not by the mouse while the UI has it), the time and the flame
        // particles. Donut's test mode animates by float(1/60) a frame.
        animate() {
            const elapsedSeconds = this.test ? Math.fround(1.0 / 60.0) : Nri_GetFrameTime(this.sample);
            if (!this.test) {
                this.camera.animate(this.sample, elapsedSeconds, !this.imgui || Nri_ImguiWantsMouse() == 0);
            }
            this.time += elapsedSeconds;
            this.flameGenerator.updateParticles(elapsedSeconds);
        }

        // The Donut example's onRender: the constants, the refraction model's new vertices and its
        // BLAS updated for them, the TLAS, then the rays into the output, which then goes to the copy.
        recordRays(commandBuffer: NriCommandBufferHandle, queuedFrameIndex: int) {
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            const layout = this.layout;
            const pipeline = this.pipeline;
            const shaderTable = this.shaderTable;
            const descriptorPool = this.descriptorPool;
            const set = queuedFrame.set;
            const textureSet = this.textureSet;
            const output = this.output;
            const topLevelAS = this.topLevelAS;
            const refractionBlas = this.refractionBlas;
            const dynamicVertexBuffer = queuedFrame.dynamicVertexBuffer;
            const dynamicIndexBuffer = this.dynamicIndexBuffer;
            if (!layout || !pipeline || !shaderTable || !descriptorPool || !set || !textureSet || !output || !topLevelAS
                || !refractionBlas || !dynamicVertexBuffer || !dynamicIndexBuffer) {
                return;
            }
            this.updateUniformBuffers(queuedFrameIndex);

            // The refraction model's new vertices, and its BLAS updated for them.
            this.createDynamicObjectBuffers(this.time);
            Nri_WriteBuffer(dynamicVertexBuffer, 0, Ref(this.refractionModel[0]), GRID_SIZE * GRID_SIZE * VERTEX_SIZE);
            Nri_CmdUpdateUpdatableBlas(commandBuffer, refractionBlas, dynamicVertexBuffer, 0, dynamicIndexBuffer, 0);
            this.createTopLevelAccelerationStructure(commandBuffer, topLevelAS, queuedFrameIndex);

            // Dispatch the ray tracing commands
            if (this.outputCopied) {
                Nri_CmdTextureBarrier(commandBuffer, output, NriTextureState.CopySource, NriTextureState.RayTracingStorage);
            }
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetRayTracingPipelineLayout(commandBuffer, layout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetRayTracingDescriptorSet(commandBuffer, 0, set);
            Nri_CmdSetRayTracingDescriptorSet(commandBuffer, 1, textureSet);
            Nri_CmdDispatchRays(commandBuffer, shaderTable, this.width, this.height);
            Nri_CmdTextureBarrier(commandBuffer, output, NriTextureState.RayTracingStorage, NriTextureState.CopySource);
            this.outputCopied = true;
        }

        // The swap chain at the window's size, its textures' views (sRGB) and semaphores.
        createSwapChain(device: NriDeviceHandle) {
            this.width = Nri_GetOutputWidth(this.sample);
            this.height = Nri_GetOutputHeight(this.sample);
            this.swapChain = Nri_CreateSwapChain(this.sample, device, this.queue, Nri_GetQueuedFrameNum(this.sample) + 1);
            const textureNum = Nri_GetSwapChainTextureNum(this.swapChain);
            this.swapChainFormat = Nri_GetTextureFormat(Nri_GetSwapChainTexture(this.swapChain, 0));
            this.viewFormat = Nri_GetSrgbFormat(this.swapChainFormat);
            for (let i = 0; i < textureNum; i++) {
                const texture = Nri_GetSwapChainTexture(this.swapChain, i);
                this.swapChainTextures.push(new SwapChainTexture(texture, Nri_CreateColorAttachmentView(texture, this.viewFormat),
                    Nri_CreateSwapChainSemaphore(device), Nri_CreateSwapChainSemaphore(device)));
            }
        }

        destroySwapChain() {
            for (const swapChainTexture of this.swapChainTextures) {
                Nri_DestroyFence(swapChainTexture.acquireSemaphore);
                Nri_DestroyFence(swapChainTexture.releaseSemaphore);
                Nri_DestroyDescriptor(swapChainTexture.colorAttachment);
            }
            this.swapChainTextures = [];
            Nri_DestroySwapChain(this.swapChain);
        }

        // The output the ray generation shader writes, at the swap chain's size and in its format,
        // with its storage view.
        createOutput(device: NriDeviceHandle) {
            const output = Nri_CreateStorageTexture(device, this.queue, this.width, this.height, this.swapChainFormat);
            this.output = output;
            if (output) {
                this.outputStorage = Nri_CreateStorageTextureView(output, this.swapChainFormat);
            }
        }

        destroyOutput() {
            this.destroyDescriptor(this.outputStorage);
            this.outputStorage = null;
            const output = this.output;
            if (output) {
                Nri_DestroyTexture(output);
            }
            this.output = null;
        }

        // The window was resized (Nri_UseResizableWindow): the swap chain and the output made again
        // at its size, once the GPU is done with the old ones; every queued frame's set pointed at the
        // new output, which starts in its creation state again (no CopySource barrier first). The
        // camera's aspect ratio and the rays' dispatch read the size every frame.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (Nri_GetOutputWidth(this.sample) == this.width && Nri_GetOutputHeight(this.sample) == this.height) {
                return;
            }
            Nri_DeviceWaitIdle(device);
            // (On D3D11, or without ray tracing, initialize stopped before making the output.)
            let hadOutput = false;
            if (this.output) {
                hadOutput = true;
            }
            this.destroySwapChain();
            this.destroyOutput();
            this.createSwapChain(device);
            if (!hadOutput) {
                return;
            }
            this.createOutput(device);
            this.outputCopied = false;
            const outputStorage = this.outputStorage;
            if (!outputStorage) {
                return;
            }
            for (const queuedFrame of this.queuedFrames) {
                const set = queuedFrame.set;
                if (set) {
                    Nri_UpdateDescriptor(set, 4, 0, outputStorage);
                }
            }
        }

        // The sample's overlay: SER's settings where the device has hit objects (the Donut example's
        // UserInterface).
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPos(10.0, 10.0);
            // The sample's title (ApiVulkanSample's default).
            Nri_ImguiBegin("Vulkan Example", 1);
            if (this.serSupported) {
                this.serEnabled = Nri_ImguiCheckbox("Enable Shader Execution Reordering (SER)", this.serEnabled ? 1 : 0) != 0;
                this.coherenceHintEnabled = Nri_ImguiCheckbox("Enable Coherence Hint", this.coherenceHintEnabled ? 1 : 0) != 0;
            } else {
                Nri_ImguiText("Shader Execution Reordering is not supported");
            }
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.animate();

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: the acceleration structures and the rays, then their output copied into the
                // frame without conversion, as the sample's vkCmdCopyImage (the UNORM values become
                // the sRGB back buffer's encoded ones), then the UI over it.
                Nri_BeginCommandBuffer(commandBuffer);
                this.recordRays(commandBuffer, queuedFrameIndex);
                if (this.imgui) {
                    Nri_CmdCopyImguiData(this.sample, commandBuffer);
                }
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.CopyDestination);
                const output = this.output;
                if (output) {
                    Nri_CmdCopyTexture(commandBuffer, swapChainTexture.texture, output);
                }
                let presentFrom = NriTextureState.CopyDestination;
                if (this.imgui) {
                    Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.CopyDestination, NriTextureState.ColorAttachment);
                    Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
                    Nri_CmdDrawImgui(this.sample, commandBuffer, this.viewFormat);
                    Nri_CmdEndRendering(commandBuffer);
                    presentFrom = NriTextureState.ColorAttachment;
                }

                // The test's last frame: read back
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    if (frameIndex == TEST_FRAMES - 1) {
                        Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, presentFrom, NriTextureState.CopySource);
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
                    this.destroyDescriptor(queuedFrame.constantsView);
                    this.destroyDescriptor(queuedFrame.dynamicVertexView);
                    this.destroyBuffer(queuedFrame.dynamicVertexBuffer);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    Nri_DestroyDescriptorPool(descriptorPool);
                }
                this.destroyOutput();
                this.destroyDescriptor(this.topLevelASView);
                this.destroyDescriptor(this.vertexView);
                this.destroyDescriptor(this.indexView);
                this.destroyDescriptor(this.dataToModelView);
                this.destroyDescriptor(this.dynamicIndexView);
                this.destroyDescriptor(this.sampler);
                for (const view of this.textureViews) {
                    Nri_DestroyDescriptor(view);
                }
                for (const texture of this.textures) {
                    Nri_DestroyTexture(texture);
                }
                const topLevelAS = this.topLevelAS;
                if (topLevelAS) {
                    Nri_DestroyTopLevelAS(topLevelAS);
                }
                for (const modelBuffer of this.modelBuffers) {
                    // (The refraction model's is its updatable BLAS'.)
                    const blas = modelBuffer.blas;
                    if (modelBuffer.isStatic) {
                        if (blas) {
                            Nri_DestroyAccelerationStructure(blas);
                        }
                    }
                }
                const refractionBlas = this.refractionBlas;
                if (refractionBlas) {
                    Nri_DestroyUpdatableBlas(refractionBlas);
                }
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.indexBuffer);
                this.destroyBuffer(this.dataToModelBuffer);
                this.destroyBuffer(this.dynamicIndexBuffer);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                const shaderTable = this.shaderTable;
                if (shaderTable) {
                    Nri_DestroyShaderTable(shaderTable);
                }
                const pipeline = this.pipeline;
                if (pipeline) {
                    Nri_DestroyPipeline(pipeline);
                }
                const layout = this.layout;
                if (layout) {
                    Nri_DestroyPipelineLayout(layout);
                }
                Nri_DestroyFence(this.frameFence);
                this.destroySwapChain();
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
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const example = new RayTracingInvocationReorder(sample);
        // -mode <0..6>: the sample's render mode (its specialization constant): 0 default,
        // 1 barycentric, 2 instance ID, 3 distance, 4 global XYZ, 5 shadow map, 6 ambient occlusion
        // (as in the sample, 5 and 6 show the hit's texture: its ray generation shader stops before
        // their shadow and AO output). -noser, -nohint: SER, its coherence hint off at start. -noUI:
        // no overlay.
        Nri_AddExampleOptionWithValues(sample, "-mode", 1);
        Nri_AddExampleOption(sample, "-noser");
        Nri_AddExampleOption(sample, "-nohint");
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        Nri_UseResizableWindow(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-noser") {
                example.serEnabled = false;
            } else if (arg == "-nohint") {
                example.coherenceHintEnabled = false;
            } else if (arg == "-noUI") {
                example.noUI = true;
            } else if (arg == "-mode" && i + 1 < argc) {
                i++;
                // Clamped to 0 .. 6 (tslang's Math.max is wrong for negative numbers).
                const mode = parseInt(Nri_GetArg(argc, argv, i));
                example.renderMode = mode < 0 ? 0 : (mode > 6 ? 6 : mode);
            }
        }
        return example.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return RayTracingInvocationReorderNri.main(argc, argv);
}

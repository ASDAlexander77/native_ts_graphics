/// <reference path="../../core/nri/nri_interop.d.ts" />
import {
    cross3, matrixIdentity, matrixInverse, matrixLookAtLH, matrixMultiply, matrixPerspectiveFovLH,
    matrixRotationY, matrixScaling, matrixTranslation, normalize3, normalize4, radians, transform3, vsub,
} from "../../core/directx_math";

namespace ProceduralGeometryNri {
    // procedural_geometry, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (procedural_geometry.hlsl's library), through the NRI calls
    // core/nri/nri_interop.d.ts binds. This example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no ray tracing, or no shaders for
    // the graphics API (D3D11).
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: D3D12 Raytracing - Procedural Geometry";

    // The sample's RaytracingSceneDefines.h and RaytracingHlslCompat.h.
    // max(sizeof(RayPayload) = float4 + uint, sizeof(ShadowRayPayload)).
    const PAYLOAD_SIZE = 20;
    // sizeof(ProceduralPrimitiveAttributes): float3 normal.
    const ATTRIBUTE_SIZE = 12;
    // MAX_RAY_RECURSION_DEPTH: primary rays + reflections + shadow rays from reflected geometry.
    const MAX_RECURSION_DEPTH = 3;
    const RAY_TYPE_COUNT = 2;

    // IntersectionShaderType: the hit group name part of each, and how many of the primitives
    // (AnalyticPrimitive: AABB, Spheres; VolumetricPrimitive: Metaballs; SignedDistancePrimitive:
    // MiniSpheres, IntersectedRoundCube, SquareTorus, TwistedTorus, Cog, Cylinder, FractalPyramid)
    // each intersects, in the order of the AABB geometries.
    const INTERSECTION_SHADER_NAMES = [
        "AnalyticPrimitive", "VolumetricPrimitive", "SignedDistancePrimitive",
    ];
    const PRIMITIVES_PER_INTERSECTION_SHADER = [2, 1, 7];
    // IntersectionShaderType::TotalPrimitiveCount.
    const PRIMITIVE_COUNT = 10;

    // c_aabbWidth, c_aabbDistance.
    const AABB_WIDTH = 2.0;
    const AABB_DISTANCE = 2.0;

    // Each AABB's grid cell (BuildProceduralGeometryAABBs' offsetIndex) and size, by geometry index.
    const AABB_OFFSETS = [
        3.0, 0.0, 0.0,
        2.25, 0.0, 0.75,
        0.0, 0.0, 0.0,
        2.0, 0.0, 0.0,
        0.0, 0.0, 2.0,
        0.75, -0.1, 2.25,
        0.0, 0.0, 1.0,
        1.0, 0.0, 0.0,
        0.0, 0.0, 3.0,
        2.0, 0.0, 2.0,
    ];
    const AABB_SIZES = [
        2.0, 3.0, 2.0,
        3.0, 3.0, 3.0,
        3.0, 3.0, 3.0,
        2.0, 2.0, 2.0,
        2.0, 2.0, 2.0,
        3.0, 3.0, 3.0,
        2.0, 2.0, 2.0,
        2.0, 2.0, 2.0,
        2.0, 3.0, 2.0,
        6.0, 6.0, 6.0,
    ];
    // UpdateAABBPrimitiveAttributes: each AABB's scale (x, y, z) and whether it rotates.
    const AABB_SCALES = [
        1.0, 1.5, 1.0,
        1.5, 1.5, 1.5,
        1.5, 1.5, 1.5,
        1.0, 1.0, 1.0,
        1.0, 1.0, 1.0,
        1.5, 1.5, 1.5,
        1.0, 1.0, 1.0,
        1.0, 1.0, 1.0,
        1.0, 1.5, 1.0,
        3.0, 3.0, 3.0,
    ];
    const AABB_ROTATES = [false, true, true, false, false, false, true, true, false, false];

    // InitializeScene's materials (PrimitiveConstantBuffer: albedo, reflectanceCoef, diffuseCoef,
    // specularCoef, specularPower, stepScale), the AABB geometries' then the plane's.
    const GREEN = [0.1, 1.0, 0.5, 1.0];
    const RED = [1.0, 0.5, 0.5, 1.0];
    const YELLOW = [1.0, 1.0, 0.5, 1.0];
    const CHROMIUM_REFLECTANCE = [0.549, 0.556, 0.554, 1.0];
    const PLANE_ALBEDO = [0.9, 0.9, 0.9, 1.0];
    // Floats per PrimitiveConstantBuffer (48 bytes, with its padding).
    const MATERIAL_FLOATS = 12;
    // Floats per PrimitiveInstancePerFrameBuffer: two float4x4.
    const AABB_ATTRIBUTE_FLOATS = 32;
    // sizeof(PrimitiveInstanceConstantBuffer): instanceIndex, primitiveType.
    const AABB_CONSTANTS_STRIDE = 8;

    // BuildPlaneGeometry: a unit square on y = 0 (Vertex: position, normal), two triangles.
    const PLANE_VERTICES: f32[] = [
        0.0, 0.0, 0.0, 0.0, 1.0, 0.0,
        1.0, 0.0, 0.0, 0.0, 1.0, 0.0,
        1.0, 0.0, 1.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 1.0, 0.0, 1.0, 0.0,
    ];
    const PLANE_INDICES: int[] = [3, 1, 0, 2, 1, 3];

    // SceneConstantBuffer, padded to a constant buffer's 256 bytes.
    const SCENE_CB_SIZE = 256;

    // GLFW's key codes of the animation toggles.
    const KEY_C = 67;
    const KEY_G = 71;
    const KEY_L = 76;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into, its scene constants' and AABB transforms' copies (written
    // while the frames before it may still be reading theirs) and its set.
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public sceneConstantsView: NriDescriptorHandle | null, public aabbAttributeBuffer: NriBufferHandle | null,
            public aabbAttributeView: NriDescriptorHandle | null, public set: NriDescriptorSetHandle | null) {
        }
    }

    // A swap chain texture and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // The frame's pixels (0xAABBGGRR) as test_check's TestCheck reads them.
    class Frame {
        constructor(public pixels: int[], public width: int, public height: int) {
        }

        // The pixel's 0xBBGGRR.
        rgb(x: int, y: int): int {
            return this.pixels[y * this.width + x] & 0xFFFFFF;
        }

        // The pixels whose channels are within the ranges.
        countInRange(rMin: int, rMax: int, gMin: int, gMax: int, bMin: int, bMax: int): int {
            let count = 0;
            for (let i = 0; i < this.width * this.height; i++) {
                const p = this.pixels[i];
                const r = p & 0xFF;
                const g = (p >> 8) & 0xFF;
                const b = (p >> 16) & 0xFF;
                if (r >= rMin && r <= rMax && g >= gMin && g <= gMax && b >= bMin && b <= bMax) {
                    count++;
                }
            }
            return count;
        }

        // The pixels whose largest and smallest channels are at least `spread` apart (colors, not
        // grays).
        countColors(spread: int): int {
            let count = 0;
            for (let i = 0; i < this.width * this.height; i++) {
                const p = this.pixels[i];
                const r = p & 0xFF;
                const g = (p >> 8) & 0xFF;
                const b = (p >> 16) & 0xFF;
                let high = r;
                let low = r;
                if (g > high) {
                    high = g;
                }
                if (b > high) {
                    high = b;
                }
                if (g < low) {
                    low = g;
                }
                if (b < low) {
                    low = b;
                }
                if (high - low >= spread) {
                    count++;
                }
            }
            return count;
        }

        // "" if count is min% to max% of the frame, else why not.
        share(count: int, min: number, max: number, what: string): string {
            const total = this.width * this.height;
            const percent = 100.0 * count / total;
            console.log(`${what}: ${percent}% (${count} of ${total} pixels)`);
            if (percent < min || percent > max) {
                return `${what}: ${percent}% of the pixels, not ${min}% to ${max}%`;
            }
            return "";
        }
    }

    // -test: checks the last frame, read back, as the Donut example does. The top corners are the
    // sky; the procedural objects color about 9% of the frame (the green pyramid and menger sponge
    // about 2%), the reflective floor's highlights about 6% white.
    function checkFrame(frame: Frame) {
        if (frame.pixels.length == 0) {
            return "cannot read the back buffer";
        }
        if (frame.rgb(0, 0) != 0xFFE5CC || frame.rgb(frame.width - 1, 0) != 0xFFE5CC) {
            return "the top corners aren't the sky";
        }
        const colored = frame.share(frame.countColors(61), 5.0, 14.0, "Colored");
        if (colored != "") {
            return colored;
        }
        const green = frame.share(frame.countInRange(0, 89, 121, 255, 0, 89), 0.8, 3.5, "Green");
        if (green != "") {
            return green;
        }
        return frame.share(frame.countInRange(221, 255, 221, 255, 221, 255), 3.0, 10.0, "White");
    }

    // Port of DirectX-Graphics-Samples' D3D12RaytracingProceduralGeometry, as
    // examples/procedural_geometry.ts ports it, to NRI: a checkered plane (a triangle BLAS) and ten
    // AABBs (an AABB BLAS, one geometry each) whose analytic, volumetric (metaballs) and signed
    // distance (including a fractal pyramid) primitives three intersection shaders find, with radiance
    // and shadow rays (a hit group for each geometry and ray type), reflections and Phong lighting. C,
    // G and L toggle the camera's, the geometry's and the light's animations. The output, in the back
    // buffer's format, is copied into it.
    class ProceduralGeometry {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private layout: NriPipelineLayoutHandle | null = null;
        private pipeline: NriPipelineHandle | null = null;
        private shaderTable: NriShaderTableHandle | null = null;
        private planeBlas: NriAccelerationStructureHandle | null = null;
        private aabbBlas: NriAccelerationStructureHandle | null = null;
        private topLevelAS: NriTopLevelASHandle | null = null;
        private topLevelASView: NriDescriptorHandle | null = null;
        // The plane's indices and vertices (the closest hit shader's g_indices, g_vertices: 4-byte
        // elements), the materials, the AABBs' PrimitiveInstanceConstantBuffers.
        private indexBuffer: NriBufferHandle | null = null;
        private vertexBuffer: NriBufferHandle | null = null;
        private materialBuffer: NriBufferHandle | null = null;
        private aabbConstantBuffer: NriBufferHandle | null = null;
        private bufferViews: NriDescriptorHandle[] = [];
        // The scene constants, SCENE_CB_SIZE bytes a frame in flight.
        private sceneConstantBuffer: NriBufferHandle | null = null;
        private output: NriTextureHandle | null = null;
        private outputStorage: NriDescriptorHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        // The output was copied from (after the first frame).
        private outputCopied: boolean = false;
        private width: int = 0;
        private height: int = 0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        // The scene (InitializeScene): the AABBs' min x y z, max x y z; the camera; the light.
        private aabbs: f32[] = [];
        private eye: number[] = [];
        private at: number[] = [];
        private up: number[] = [];
        private lightPosition: number[] = [0.0, 18.0, -20.0, 0.0];

        private sceneData: f32[] = [];
        private aabbAttributes: f32[] = [];

        private animateGeometryTime: number = 0.0;
        private animateCamera: boolean = false;
        private animateGeometry: boolean = true;
        private animateLight: boolean = false;
        // The toggle keys' states last frame (C, G, L).
        private keysDown: boolean[] = [false, false, false];

        // -benchmark: 1/60 s per frame (for comparisons).
        benchmark: boolean = false;
        // -time <seconds>: the geometry animation's time, fixed.
        fixedTime: number = -1.0;

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < SCENE_CB_SIZE / 4; i++) {
                this.sceneData.push(0.0);
            }
            for (let i = 0; i < PRIMITIVE_COUNT * AABB_ATTRIBUTE_FLOATS; i++) {
                this.aabbAttributes.push(0.0);
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
                const failure = checkFrame(new Frame(this.readBack(), this.width, this.height));
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

            // Swap chain: copied into, in its own (UNORM) format, as the sample's CopyResource.
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.swapChain = Nri_CreateSwapChain(this.sample, device, this.queue, queuedFrameNum + 1);
            const textureNum = Nri_GetSwapChainTextureNum(this.swapChain);
            const format = Nri_GetTextureFormat(Nri_GetSwapChainTexture(this.swapChain, 0));
            for (let i = 0; i < textureNum; i++) {
                this.swapChainTextures.push(new SwapChainTexture(Nri_GetSwapChainTexture(this.swapChain, i),
                    Nri_CreateSwapChainSemaphore(device), Nri_CreateSwapChainSemaphore(device)));
            }

            // Queued frames (their sets come below)
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), null, null, null, null));
            }

            // Ray tracing pipelines: D3D12 or Vulkan (the Donut example's shaders have no DXBC).
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "No D3D11 shaders (ray tracing needs D3D12 or Vulkan)";
                return 0;
            }
            if (Nri_IsFeatureSupported(device, NriFeature.RayTracing) == 0) {
                this.unsupportedReason = "The graphics device does not support Ray Tracing Pipelines";
                return 0;
            }

            // CreateRootSignatures' global root signature (the local ones' constants are in t4, t5):
            // the scene (t0), the output (u0), the scene constants (b0), the plane's indices and
            // vertices, the AABBs' transforms, the materials, the AABBs' constants (t1 to t5).
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.AccelerationStructure, NriStage.RayTracing, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.StorageTexture, NriStage.RayTracing, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.RayTracing, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 1, 5, NriDescriptorType.StructuredBuffer, NriStage.RayTracing, NriRangeFlags.None);
            const layout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            this.layout = layout;
            if (!layout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }
            if (!this.createRayTracingPipeline(device, layout, graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv")) {
                return 0;
            }

            // InitializeScene's camera: from (0, 5.3, -17) towards the origin, its up vector
            // perpendicular to the view direction and x, both turned 45 degrees about y.
            this.eye = [0.0, Math.fround(5.3), -17.0, 1.0];
            this.at = [0.0, 0.0, 0.0, 1.0];
            const direction = normalize4(vsub(this.at, this.eye));
            this.up = normalize3(cross3(direction, [1.0, 0.0, 0.0, 0.0]));
            const rotate = matrixRotationY(radians(45.0));
            this.eye = transform3(this.eye, rotate);
            this.up = transform3(this.up, rotate);

            this.buildAabbs();
            if (!this.createBuffers(device) || !this.createAccelerationStructures(device)) {
                return 0;
            }

            // The scene constants, written every frame into the frame's part.
            const sceneConstantBuffer = Nri_CreateHostBuffer(device, SCENE_CB_SIZE * queuedFrameNum, NriBufferUsage.ConstantBuffer);
            this.sceneConstantBuffer = sceneConstantBuffer;

            // The output the ray generation shader writes, in the back buffer's format, for the copy.
            const output = Nri_CreateStorageTexture(device, this.queue, this.width, this.height, format);
            this.output = output;
            const descriptorPool = Nri_CreateDescriptorPoolWithAccelerationStructures(device, queuedFrameNum, 0, queuedFrameNum, 0,
                queuedFrameNum, 5 * queuedFrameNum, queuedFrameNum);
            this.descriptorPool = descriptorPool;
            const topLevelASView = this.topLevelASView;
            if (!sceneConstantBuffer || !output || !descriptorPool || !topLevelASView) {
                console.log("Cannot create the output");
                return 0;
            }
            const outputStorage = Nri_CreateStorageTextureView(output, format);
            this.outputStorage = outputStorage;
            if (!outputStorage) {
                console.log("Cannot create the output's view");
                return 0;
            }

            // A set per frame in flight: its own part of the scene constants, its own AABB transforms.
            for (let i = 0; i < queuedFrameNum; i++) {
                const queuedFrame = this.queuedFrames[i];
                const sceneConstantsView = Nri_CreateConstantBufferView(sceneConstantBuffer, i * SCENE_CB_SIZE, SCENE_CB_SIZE);
                queuedFrame.sceneConstantsView = sceneConstantsView;
                const aabbAttributeBuffer = Nri_CreateHostBufferWithStride(device, this.aabbAttributes.length * 4,
                    NriBufferUsage.StructuredBuffer, AABB_ATTRIBUTE_FLOATS * 4);
                queuedFrame.aabbAttributeBuffer = aabbAttributeBuffer;
                const aabbAttributeView = aabbAttributeBuffer ? Nri_CreateStructuredBufferView(aabbAttributeBuffer, 0) : null;
                queuedFrame.aabbAttributeView = aabbAttributeView;
                const set = Nri_AllocateDescriptorSet(descriptorPool, layout, 0, 0);
                queuedFrame.set = set;
                if (!set || !sceneConstantsView || !aabbAttributeView) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(set, 0, 0, topLevelASView);
                Nri_UpdateDescriptor(set, 1, 0, outputStorage);
                Nri_UpdateDescriptor(set, 2, 0, sceneConstantsView);
                Nri_UpdateDescriptor(set, 3, 0, this.bufferViews[0]);
                Nri_UpdateDescriptor(set, 3, 1, this.bufferViews[1]);
                Nri_UpdateDescriptor(set, 3, 2, aabbAttributeView);
                Nri_UpdateDescriptor(set, 3, 3, this.bufferViews[2]);
                Nri_UpdateDescriptor(set, 3, 4, this.bufferViews[3]);
            }

            if (this.test) {
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // CreateRaytracingPipelineStateObject and BuildShaderTables: the ray generation shader, the
        // radiance and shadow miss shaders, the plane's hit groups (a closest hit shader for radiance
        // rays, nothing for shadow rays: they skip closest hit shaders, so a null record), and each
        // intersection shader's (with the AABB closest hit shader for radiance rays); in the hit group
        // table the plane's two, then each AABB's two. False (after printing why) on failure.
        createRayTracingPipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, folder: string): boolean {
            const desc = Nri_CreateRayTracingPipelineDesc();
            const raygenGroup = Nri_RayTracingPipelineDescAddGroup(desc,
                Nri_RayTracingPipelineDescAddShader(desc, NriStage.RayGen, "MyRaygenShader"), -1, -1);
            const missGroup = Nri_RayTracingPipelineDescAddGroup(desc,
                Nri_RayTracingPipelineDescAddShader(desc, NriStage.Miss, "MyMissShader"), -1, -1);
            const shadowMissGroup = Nri_RayTracingPipelineDescAddGroup(desc,
                Nri_RayTracingPipelineDescAddShader(desc, NriStage.Miss, "MyMissShader_ShadowRay"), -1, -1);
            const triangleGroup = Nri_RayTracingPipelineDescAddGroup(desc,
                Nri_RayTracingPipelineDescAddShader(desc, NriStage.ClosestHit, "MyClosestHitShader_Triangle"), -1, -1);
            const aabbClosestHit = Nri_RayTracingPipelineDescAddShader(desc, NriStage.ClosestHit, "MyClosestHitShader_AABB");
            // Each intersection shader's radiance and shadow ray hit groups.
            const aabbGroups: int[] = [];
            for (const name of INTERSECTION_SHADER_NAMES) {
                const intersection = Nri_RayTracingPipelineDescAddShader(desc, NriStage.Intersection, `MyIntersectionShader_${name}`);
                aabbGroups.push(Nri_RayTracingPipelineDescAddGroup(desc, aabbClosestHit, intersection, -1));
                aabbGroups.push(Nri_RayTracingPipelineDescAddGroup(desc, intersection, -1, -1));
            }
            const pipeline = Nri_CreateRayTracingPipelineFromDesc(device, layout,
                `shaders/procedural_geometry/${folder}/procedural_geometry.bin`, desc, PAYLOAD_SIZE, ATTRIBUTE_SIZE, MAX_RECURSION_DEPTH);
            Nri_DestroyRayTracingPipelineDesc(desc);
            this.pipeline = pipeline;
            if (!pipeline) {
                console.log("Cannot initialize the ray tracing pipeline");
                return false;
            }

            const missGroups: int[] = [missGroup, shadowMissGroup];
            const hitGroups: int[] = [triangleGroup, -1];
            for (let t = 0; t < INTERSECTION_SHADER_NAMES.length; t++) {
                for (let primitive = 0; primitive < PRIMITIVES_PER_INTERSECTION_SHADER[t]; primitive++) {
                    hitGroups.push(aabbGroups[t * 2]);
                    hitGroups.push(aabbGroups[t * 2 + 1]);
                }
            }
            this.shaderTable = Nri_CreateShaderTableFromGroups(device, this.queue, pipeline, raygenGroup, Ref(missGroups[0]), missGroups.length,
                Ref(hitGroups[0]), hitGroups.length);
            if (!this.shaderTable) {
                console.log("Cannot create the shader table");
                return false;
            }
            return true;
        }

        // BuildProceduralGeometryAABBs: the AABBs on a 4 x 1 x 4 grid of cells 4 apart, centered on
        // the origin, in float arithmetic as the sample's.
        buildAabbs() {
            const grid = [4.0, 1.0, 4.0];
            const stride = AABB_WIDTH + AABB_DISTANCE;
            for (let i = 0; i < PRIMITIVE_COUNT; i++) {
                for (let c = 0; c < 6; c++) {
                    const axis = c % 3;
                    const base = Math.fround(-(grid[axis] * AABB_WIDTH + (grid[axis] - 1.0) * AABB_DISTANCE) / 2.0);
                    const min = Math.fround(base + Math.fround(Math.fround(AABB_OFFSETS[i * 3 + axis]) * stride));
                    const value = c < 3 ? min : Math.fround(min + AABB_SIZES[i * 3 + axis]);
                    this.aabbs.push(value);
                }
            }
        }

        // A PrimitiveConstantBuffer (SetAttributes).
        addMaterial(materials: f32[], albedo: number[], reflectanceCoef: number, diffuseCoef: number,
            specularCoef: number, specularPower: number, stepScale: number) {
            for (let i = 0; i < 4; i++) {
                materials.push(albedo[i]);
            }
            materials.push(reflectanceCoef);
            materials.push(diffuseCoef);
            materials.push(specularCoef);
            materials.push(specularPower);
            materials.push(stepScale);
            materials.push(0.0);
            materials.push(0.0);
            materials.push(0.0);
        }

        // The plane's indices and vertices; InitializeScene's materials, the AABB geometries' (in
        // geometry order) then the plane's; each AABB geometry's PrimitiveInstanceConstantBuffer
        // (BuildShaderTables' rootArgs.aabbCB: the AABB's index, and its primitive type within its
        // intersection shader's). Uploaded once. False (after printing why) on failure.
        createBuffers(device: NriDeviceHandle): boolean {
            const materials: f32[] = [];
            // SetAttributes' defaults: reflectanceCoef 0, diffuseCoef 0.9, specularCoef 0.7,
            // specularPower 50, stepScale 1.
            this.addMaterial(materials, RED, 0.0, 0.9, 0.7, 50.0, 1.0);                     // AABB
            this.addMaterial(materials, CHROMIUM_REFLECTANCE, 1.0, 0.9, 0.7, 50.0, 1.0);    // Spheres
            this.addMaterial(materials, CHROMIUM_REFLECTANCE, 1.0, 0.9, 0.7, 50.0, 1.0);    // Metaballs
            this.addMaterial(materials, GREEN, 0.0, 0.9, 0.7, 50.0, 1.0);                   // MiniSpheres
            this.addMaterial(materials, GREEN, 0.0, 0.9, 0.7, 50.0, 1.0);                   // IntersectedRoundCube
            this.addMaterial(materials, CHROMIUM_REFLECTANCE, 1.0, 0.9, 0.7, 50.0, 1.0);    // SquareTorus
            this.addMaterial(materials, YELLOW, 0.0, 1.0, 0.7, 50.0, 0.5);                  // TwistedTorus
            this.addMaterial(materials, YELLOW, 0.0, 1.0, 0.1, 2.0, 1.0);                   // Cog
            this.addMaterial(materials, RED, 0.0, 0.9, 0.7, 50.0, 1.0);                     // Cylinder
            this.addMaterial(materials, GREEN, 0.0, 1.0, 0.1, 4.0, 0.8);                    // FractalPyramid
            this.addMaterial(materials, PLANE_ALBEDO, 0.25, 1.0, 0.4, 50.0, 1.0);           // the plane

            const aabbConstants: int[] = [];
            let instanceIndex = 0;
            for (const primitiveCount of PRIMITIVES_PER_INTERSECTION_SHADER) {
                for (let primitive = 0; primitive < primitiveCount; primitive++) {
                    aabbConstants.push(instanceIndex);
                    aabbConstants.push(primitive);
                    instanceIndex++;
                }
            }

            const indexBuffer = Nri_CreateUploadedStructuredBufferFromInts(device, this.queue, Ref(PLANE_INDICES[0]),
                PLANE_INDICES.length * 4, 4);
            this.indexBuffer = indexBuffer;
            const vertexBuffer = Nri_CreateUploadedStructuredBuffer(device, this.queue, Ref(PLANE_VERTICES[0]), PLANE_VERTICES.length * 4, 4);
            this.vertexBuffer = vertexBuffer;
            const materialBuffer = Nri_CreateUploadedStructuredBuffer(device, this.queue, Ref(materials[0]), materials.length * 4,
                MATERIAL_FLOATS * 4);
            this.materialBuffer = materialBuffer;
            const aabbConstantBuffer = Nri_CreateUploadedStructuredBufferFromInts(device, this.queue, Ref(aabbConstants[0]),
                aabbConstants.length * 4, AABB_CONSTANTS_STRIDE);
            this.aabbConstantBuffer = aabbConstantBuffer;
            if (!indexBuffer || !vertexBuffer || !materialBuffer || !aabbConstantBuffer) {
                console.log("Cannot create the scene's buffers");
                return false;
            }
            const views = [
                Nri_CreateStructuredBufferView(indexBuffer, 0),
                Nri_CreateStructuredBufferView(vertexBuffer, 0),
                Nri_CreateStructuredBufferView(materialBuffer, 0),
                Nri_CreateStructuredBufferView(aabbConstantBuffer, 0),
            ];
            for (const view of views) {
                if (!view) {
                    console.log("Cannot create the scene's buffer views");
                    return false;
                }
                this.bufferViews.push(view);
            }
            return true;
        }

        // BuildGeometry and BuildAccelerationStructures: the plane's BLAS, the AABBs' (one geometry per
        // AABB, for a hit group per AABB), opaque, built preferring fast tracing; the TLAS's two
        // instances, built once: they don't move. False (after printing why) on failure.
        createAccelerationStructures(device: NriDeviceHandle): boolean {
            const vertexCount = PLANE_VERTICES.length / 6;
            const positions: f32[] = [];
            for (let v = 0; v < vertexCount; v++) {
                for (let c = 0; c < 3; c++) {
                    positions.push(PLANE_VERTICES[v * 6 + c]);
                }
            }
            const planeDesc = Nri_CreateBlasDesc();
            Nri_BlasDescAddTriangles(planeDesc, Ref(positions[0]), vertexCount, Ref(PLANE_INDICES[0]), PLANE_INDICES.length);
            const planeBlas = Nri_BuildBlasFromDesc(device, this.queue, planeDesc, NriAccelerationStructureFlags.PreferFastTrace);
            Nri_DestroyBlasDesc(planeDesc);
            this.planeBlas = planeBlas;

            const aabbDesc = Nri_CreateBlasDesc();
            for (let i = 0; i < PRIMITIVE_COUNT; i++) {
                Nri_BlasDescAddAabbs(aabbDesc, Ref(this.aabbs[i * 6]), 1);
            }
            const aabbBlas = Nri_BuildBlasFromDesc(device, this.queue, aabbDesc, NriAccelerationStructureFlags.PreferFastTrace);
            Nri_DestroyBlasDesc(aabbDesc);
            this.aabbBlas = aabbBlas;
            if (!planeBlas || !aabbBlas) {
                console.log("Cannot build the bottom level acceleration structures");
                return false;
            }

            // BuildBotomLevelASInstanceDescs: the plane, a little larger than a 700 x 700 grid of AABBs,
            // from -0.35 of its width; the AABBs moved up onto it, their hit groups after the plane's
            // two.
            const topLevelAS = Nri_CreateTopLevelAS(device, 2, NriAccelerationStructureFlags.PreferFastTrace, 1);
            this.topLevelAS = topLevelAS;
            if (!topLevelAS) {
                console.log("Cannot create the top level acceleration structure");
                return false;
            }
            const planeWidthX = 700.0 * AABB_WIDTH + 699.0 * AABB_DISTANCE;
            const planeWidthY = 1.0 * AABB_WIDTH;
            const planeWidthZ = 700.0 * AABB_WIDTH + 699.0 * AABB_DISTANCE;
            const transform: f32[] = [
                planeWidthX, 0.0, 0.0, Math.fround(planeWidthX * Math.fround(-0.35)),
                0.0, planeWidthY, 0.0, 0.0,
                0.0, 0.0, planeWidthZ, Math.fround(planeWidthZ * Math.fround(-0.35)),
            ];
            Nri_TopLevelASAddInstance(topLevelAS, planeBlas, Ref(transform[0]), 0, 1, 0, 0);
            const aabbTransform: f32[] = [
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, AABB_WIDTH / 2.0,
                0.0, 0.0, 1.0, 0.0,
            ];
            Nri_TopLevelASAddInstance(topLevelAS, aabbBlas, Ref(aabbTransform[0]), 0, 1, RAY_TYPE_COUNT, 0);
            if (Nri_BuildTopLevelASOnQueue(this.queue, topLevelAS) == 0) {
                console.log("Cannot build the top level acceleration structure");
                return false;
            }
            this.topLevelASView = Nri_CreateAccelerationStructureDescriptor(Nri_GetTopLevelAccelerationStructure(topLevelAS));
            return true;
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // Whether the toggle key (keysDown's index) went down since the last frame.
        keyPressed(index: int, key: int): boolean {
            const down = Nri_IsKeyPressed(this.sample, key) != 0;
            const pressed = down && !this.keysDown[index];
            this.keysDown[index] = down;
            return pressed;
        }

        // The sample's OnUpdate (C, G and L toggle the animations).
        animate(elapsedSeconds: number) {
            if (this.keyPressed(0, KEY_C)) {
                this.animateCamera = !this.animateCamera;
            }
            if (this.keyPressed(1, KEY_G)) {
                this.animateGeometry = !this.animateGeometry;
            }
            if (this.keyPressed(2, KEY_L)) {
                this.animateLight = !this.animateLight;
            }
            const elapsedSeconds32 = Math.fround(elapsedSeconds);
            const elapsedTime = this.benchmark ? Math.fround(1.0 / 60.0) : elapsedSeconds32;

            // Rotate the camera around Y axis.
            if (this.animateCamera) {
                const secondsToRotateAround = 48.0;
                const angleToRotateBy = Math.fround(360.0 * Math.fround(elapsedTime / secondsToRotateAround));
                const rotate = matrixRotationY(radians(angleToRotateBy));
                this.eye = transform3(this.eye, rotate);
                this.up = transform3(this.up, rotate);
                this.at = transform3(this.at, rotate);
            }

            // Rotate the light around Y axis.
            if (this.animateLight) {
                const secondsToRotateAround = 8.0;
                const angleToRotateBy = Math.fround(-360.0 * Math.fround(elapsedTime / secondsToRotateAround));
                const rotate = matrixRotationY(radians(angleToRotateBy));
                this.lightPosition = transform3(this.lightPosition, rotate);
            }

            // Transform the procedural geometry.
            if (this.animateGeometry) {
                this.animateGeometryTime = Math.fround(this.animateGeometryTime + elapsedTime);
            }
            if (this.fixedTime >= 0.0) {
                this.animateGeometryTime = Math.fround(this.fixedTime);
            }
        }

        // UpdateCameraMatrices: projectionToWorld, the inverse of the view-projection matrix (45 degrees
        // vertically, depth 0.01 to 125), and the camera position.
        writeSceneConstants(width: int, height: int) {
            const view = matrixLookAtLH(this.eye, this.at, this.up);
            const proj = matrixPerspectiveFovLH(radians(45.0), Math.fround(width / height), 0.01, 125.0);
            const projectionToWorld = matrixInverse(matrixMultiply(view, proj));
            for (let i = 0; i < 16; i++) {
                this.sceneData[i] = projectionToWorld[i];
            }
            for (let i = 0; i < 4; i++) {
                this.sceneData[16 + i] = this.eye[i];
                this.sceneData[20 + i] = this.lightPosition[i];
            }
            // lightAmbientColor, lightDiffuseColor.
            for (let i = 0; i < 3; i++) {
                this.sceneData[24 + i] = 0.25;
                this.sceneData[28 + i] = 0.6;
            }
            this.sceneData[27] = 1.0;
            this.sceneData[31] = 1.0;
            // reflectance (unused), elapsedTime.
            this.sceneData[32] = 0.0;
            this.sceneData[33] = this.animateGeometryTime;
        }

        // UpdateAABBPrimitiveAttributes: each AABB's local space (scaled, rotated about y by
        // -2 * animationTime, centered on the AABB) to the BLAS's space, and back.
        writeAabbAttributes(animationTime: number) {
            const rotation = matrixRotationY(Math.fround(-2.0 * animationTime));
            const identity = matrixIdentity();
            for (let i = 0; i < PRIMITIVE_COUNT; i++) {
                const center = [
                    Math.fround(0.5 * Math.fround(this.aabbs[i * 6] + this.aabbs[i * 6 + 3])),
                    Math.fround(0.5 * Math.fround(this.aabbs[i * 6 + 1] + this.aabbs[i * 6 + 4])),
                    Math.fround(0.5 * Math.fround(this.aabbs[i * 6 + 2] + this.aabbs[i * 6 + 5])),
                ];
                const scale = matrixScaling(AABB_SCALES[i * 3], AABB_SCALES[i * 3 + 1], AABB_SCALES[i * 3 + 2]);
                let rotated = matrixMultiply(scale, identity);
                if (AABB_ROTATES[i]) {
                    rotated = matrixMultiply(scale, rotation);
                }
                const transform = matrixMultiply(rotated, matrixTranslation(center[0], center[1], center[2]));
                const inverse = matrixInverse(transform);
                for (let j = 0; j < 16; j++) {
                    this.aabbAttributes[i * AABB_ATTRIBUTE_FLOATS + j] = transform[j];
                    this.aabbAttributes[i * AABB_ATTRIBUTE_FLOATS + 16 + j] = inverse[j];
                }
            }
        }

        // The sample's DoRaytracing: the scene constants and the AABBs' transforms (into the frame's
        // copies), then the rays into the output, which then goes to the copy.
        recordRays(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame, frameIndex: int) {
            const layout = this.layout;
            const pipeline = this.pipeline;
            const shaderTable = this.shaderTable;
            const descriptorPool = this.descriptorPool;
            const set = queuedFrame.set;
            const output = this.output;
            const sceneConstantBuffer = this.sceneConstantBuffer;
            const aabbAttributeBuffer = queuedFrame.aabbAttributeBuffer;
            if (!layout || !pipeline || !shaderTable || !descriptorPool || !set || !output || !sceneConstantBuffer || !aabbAttributeBuffer) {
                return;
            }
            this.writeSceneConstants(this.width, this.height);
            this.writeAabbAttributes(this.animateGeometryTime);
            Nri_WriteBuffer(sceneConstantBuffer, (frameIndex % this.queuedFrames.length) * SCENE_CB_SIZE, Ref(this.sceneData[0]), SCENE_CB_SIZE);
            Nri_WriteBuffer(aabbAttributeBuffer, 0, Ref(this.aabbAttributes[0]), this.aabbAttributes.length * 4);

            if (this.outputCopied) {
                Nri_CmdTextureBarrier(commandBuffer, output, NriTextureState.CopySource, NriTextureState.RayTracingStorage);
            }
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetRayTracingPipelineLayout(commandBuffer, layout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetRayTracingDescriptorSet(commandBuffer, 0, set);
            Nri_CmdDispatchRays(commandBuffer, shaderTable, this.width, this.height);
            Nri_CmdTextureBarrier(commandBuffer, output, NriTextureState.RayTracingStorage, NriTextureState.CopySource);
            this.outputCopied = true;
        }

        // CopyRaytracingOutputToBackbuffer: without conversion, as the sample's CopyResource into its
        // UNORM back buffer.
        recordCopy(commandBuffer: NriCommandBufferHandle, texture: NriTextureHandle) {
            const output = this.output;
            if (output) {
                Nri_CmdCopyTexture(commandBuffer, texture, output);
            }
        }

        renderFrame(frameIndex: int) {
            const queuedFrame = this.queuedFrames[frameIndex % this.queuedFrames.length];

            // Animate first, as Donut's onAnimate before onRender (its test mode steps float(1/60) s).
            this.animate(this.test ? Math.fround(1.0 / 60.0) : Nri_GetFrameTime(this.sample));

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: the rays, then their output copied into the frame.
                Nri_BeginCommandBuffer(commandBuffer);
                this.recordRays(commandBuffer, queuedFrame, frameIndex);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.CopyDestination);
                this.recordCopy(commandBuffer, swapChainTexture.texture);

                // The test's last frame: read back
                let presentFrom = NriTextureState.CopyDestination;
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    if (frameIndex == TEST_FRAMES - 1) {
                        Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.CopyDestination, NriTextureState.CopySource);
                        Nri_CmdReadbackTextureToBuffer(commandBuffer, readbackBuffer, this.rowPitch, swapChainTexture.texture, this.width, this.height);
                        presentFrom = NriTextureState.CopySource;
                    }
                }
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, presentFrom, NriTextureState.Present);
                Nri_EndCommandBuffer(commandBuffer);

                // Submit and present
                Nri_QueueSubmit(this.queue, commandBuffer, acquireSemaphore, swapChainTexture.releaseSemaphore);
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
                for (const queuedFrame of this.queuedFrames) {
                    Nri_DestroyCommandBuffer(queuedFrame.commandBuffer);
                    Nri_DestroyCommandAllocator(queuedFrame.commandAllocator);
                    this.destroyDescriptor(queuedFrame.sceneConstantsView);
                    this.destroyDescriptor(queuedFrame.aabbAttributeView);
                    this.destroyBuffer(queuedFrame.aabbAttributeBuffer);
                }
                for (const swapChainTexture of this.swapChainTextures) {
                    Nri_DestroyFence(swapChainTexture.acquireSemaphore);
                    Nri_DestroyFence(swapChainTexture.releaseSemaphore);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    Nri_DestroyDescriptorPool(descriptorPool);
                }
                this.destroyDescriptor(this.outputStorage);
                for (const view of this.bufferViews) {
                    Nri_DestroyDescriptor(view);
                }
                this.destroyDescriptor(this.topLevelASView);
                const output = this.output;
                if (output) {
                    Nri_DestroyTexture(output);
                }
                this.destroyBuffer(this.sceneConstantBuffer);
                this.destroyBuffer(this.indexBuffer);
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.materialBuffer);
                this.destroyBuffer(this.aabbConstantBuffer);
                const topLevelAS = this.topLevelAS;
                if (topLevelAS) {
                    Nri_DestroyTopLevelAS(topLevelAS);
                }
                const planeBlas = this.planeBlas;
                if (planeBlas) {
                    Nri_DestroyAccelerationStructure(planeBlas);
                }
                const aabbBlas = this.aabbBlas;
                if (aabbBlas) {
                    Nri_DestroyAccelerationStructure(aabbBlas);
                }
                const shaderTable = this.shaderTable;
                if (shaderTable) {
                    Nri_DestroyShaderTable(shaderTable);
                }
                this.destroyBuffer(this.readbackBuffer);
                const pipeline = this.pipeline;
                if (pipeline) {
                    Nri_DestroyPipeline(pipeline);
                }
                const layout = this.layout;
                if (layout) {
                    Nri_DestroyPipelineLayout(layout);
                }
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
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const proceduralGeometry = new ProceduralGeometry(sample);
        // -benchmark: 1/60 s per frame; -time <seconds>: the geometry animation's time, fixed.
        Nri_AddExampleOption(sample, "-benchmark");
        Nri_AddExampleOptionWithValues(sample, "-time", 1);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-benchmark") {
                proceduralGeometry.benchmark = true;
            } else if (arg == "-time" && i + 1 < argc) {
                i++;
                proceduralGeometry.fixedTime = parseFloat(Nri_GetArg(argc, argv, i));
            }
        }
        return proceduralGeometry.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return ProceduralGeometryNri.main(argc, argv);
}

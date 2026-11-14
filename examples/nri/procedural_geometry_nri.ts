/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { Nri, NriAccelerationStructure, NriBlasDesc, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriPipeline, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriRayTracingPipelineDesc, NriSample, NriShaderTable, NriTexture, NriTopLevelAS } from "../../core/nri";
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

    // A frame in flight's own data: its scene constants' and AABB transforms' copies (written
    // while the frames before it may still be reading theirs) and its set.
    class QueuedFrame {
        constructor(public sceneConstantsView: NriDescriptor | null, public aabbAttributeBuffer: NriBuffer | null,
            public aabbAttributeView: NriDescriptor | null, public set: NriDescriptorSet | null) {
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
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        // The swap chain textures' format (UNORM), the output's.
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private queuedFrames: QueuedFrame[] = [];
        private layout: NriPipelineLayout | null = null;
        private pipeline: NriPipeline | null = null;
        private shaderTable: NriShaderTable | null = null;
        private planeBlas: NriAccelerationStructure | null = null;
        private aabbBlas: NriAccelerationStructure | null = null;
        private topLevelAS: NriTopLevelAS | null = null;
        private topLevelASView: NriDescriptor | null = null;
        // The plane's indices and vertices (the closest hit shader's g_indices, g_vertices: 4-byte
        // elements), the materials, the AABBs' PrimitiveInstanceConstantBuffers.
        private indexBuffer: NriBuffer | null = null;
        private vertexBuffer: NriBuffer | null = null;
        private materialBuffer: NriBuffer | null = null;
        private aabbConstantBuffer: NriBuffer | null = null;
        private bufferViews: NriDescriptor[] = [];
        // The scene constants, SCENE_CB_SIZE bytes a frame in flight.
        private sceneConstantBuffer: NriBuffer | null = null;
        private output: NriTexture | null = null;
        private outputStorage: NriDescriptor | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
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
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
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
                const failure = checkFrame(new Frame(this.readBack(), this.width, this.height));
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

            // Swap chain: copied into, in its own (UNORM) format, as the sample's CopyResource.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, false);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;

            // Queued frames (their sets come below)
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                this.queuedFrames.push(new QueuedFrame(null, null, null, null));
            }

            // Ray tracing pipelines: D3D12 or Vulkan (the Donut example's shaders have no DXBC).
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "No D3D11 shaders (ray tracing needs D3D12 or Vulkan)";
                return 0;
            }
            if (device.isFeatureSupported(NriFeature.RayTracing) == 0) {
                this.unsupportedReason = "The graphics device does not support Ray Tracing Pipelines";
                return 0;
            }

            // CreateRootSignatures' global root signature (the local ones' constants are in t4, t5):
            // the scene (t0), the output (u0), the scene constants (b0), the plane's indices and
            // vertices, the AABBs' transforms, the materials, the AABBs' constants (t1 to t5).
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.AccelerationStructure, NriStage.RayTracing, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.StorageTexture, NriStage.RayTracing, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.RayTracing, NriRangeFlags.None);
            layoutDesc.addRange(0, 1, 5, NriDescriptorType.StructuredBuffer, NriStage.RayTracing, NriRangeFlags.None);
            const layout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
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
            const sceneConstantBuffer = device.createHostBuffer(SCENE_CB_SIZE * queuedFrameNum, NriBufferUsage.ConstantBuffer);
            this.sceneConstantBuffer = sceneConstantBuffer;

            // The output the ray generation shader writes, in the back buffer's format, for the copy.
            const output = device.createStorageTexture(this.queue, this.width, this.height, format);
            this.output = output;
            const descriptorPool = device.createDescriptorPoolWithAccelerationStructures(queuedFrameNum, 0, queuedFrameNum, 0,
                queuedFrameNum, 5 * queuedFrameNum, queuedFrameNum);
            this.descriptorPool = descriptorPool;
            const topLevelASView = this.topLevelASView;
            if (!sceneConstantBuffer || !output || !descriptorPool || !topLevelASView) {
                console.log("Cannot create the output");
                return 0;
            }
            const outputStorage = output.createStorageView(format);
            this.outputStorage = outputStorage;
            if (!outputStorage) {
                console.log("Cannot create the output's view");
                return 0;
            }

            // A set per frame in flight: its own part of the scene constants, its own AABB transforms.
            for (let i = 0; i < queuedFrameNum; i++) {
                const queuedFrame = this.queuedFrames[i];
                const sceneConstantsView = sceneConstantBuffer.createConstantView(i * SCENE_CB_SIZE, SCENE_CB_SIZE);
                queuedFrame.sceneConstantsView = sceneConstantsView;
                const aabbAttributeBuffer = device.createHostBufferWithStride(this.aabbAttributes.length * 4,
                    NriBufferUsage.StructuredBuffer, AABB_ATTRIBUTE_FLOATS * 4);
                queuedFrame.aabbAttributeBuffer = aabbAttributeBuffer;
                const aabbAttributeView = aabbAttributeBuffer ? aabbAttributeBuffer.createStructuredView(0) : null;
                queuedFrame.aabbAttributeView = aabbAttributeView;
                const set = descriptorPool.allocateDescriptorSet(layout, 0, 0);
                queuedFrame.set = set;
                if (!set || !sceneConstantsView || !aabbAttributeView) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                set.updateDescriptor(0, 0, topLevelASView);
                set.updateDescriptor(1, 0, outputStorage);
                set.updateDescriptor(2, 0, sceneConstantsView);
                set.updateDescriptor(3, 0, this.bufferViews[0]);
                set.updateDescriptor(3, 1, this.bufferViews[1]);
                set.updateDescriptor(3, 2, aabbAttributeView);
                set.updateDescriptor(3, 3, this.bufferViews[2]);
                set.updateDescriptor(3, 4, this.bufferViews[3]);
            }

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The swap chain's size and formats (its views in the textures' format).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
        }

        // The window was resized (NriSample.useResizableWindow): once the GPU is done with them, the swap
        // chain and the output made again at its size, every frame's set pointed at the new output.
        // The new output starts in Storage, as the first frame's does (no barrier from CopySource).
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
            const output = this.output;
            if (!output) {
                return;
            }
            this.destroyDescriptor(this.outputStorage);
            output.destroy();
            this.outputStorage = null;
            this.output = null;
            this.outputCopied = false;
            const newOutput = device.createStorageTexture(this.queue, this.width, this.height, this.swapChainFormat);
            this.output = newOutput;
            if (!newOutput) {
                return;
            }
            const outputStorage = newOutput.createStorageView(this.swapChainFormat);
            this.outputStorage = outputStorage;
            if (!outputStorage) {
                return;
            }
            for (const queuedFrame of this.queuedFrames) {
                const set = queuedFrame.set;
                if (set) {
                    set.updateDescriptor(1, 0, outputStorage);
                }
            }
        }

        // CreateRaytracingPipelineStateObject and BuildShaderTables: the ray generation shader, the
        // radiance and shadow miss shaders, the plane's hit groups (a closest hit shader for radiance
        // rays, nothing for shadow rays: they skip closest hit shaders, so a null record), and each
        // intersection shader's (with the AABB closest hit shader for radiance rays); in the hit group
        // table the plane's two, then each AABB's two. False (after printing why) on failure.
        createRayTracingPipeline(device: NriDevice, layout: NriPipelineLayout, folder: string): boolean {
            const desc = NriRayTracingPipelineDesc.create();
            const raygenGroup = desc.addGroup(
                desc.addShader(NriStage.RayGen, "MyRaygenShader"), -1, -1);
            const missGroup = desc.addGroup(
                desc.addShader(NriStage.Miss, "MyMissShader"), -1, -1);
            const shadowMissGroup = desc.addGroup(
                desc.addShader(NriStage.Miss, "MyMissShader_ShadowRay"), -1, -1);
            const triangleGroup = desc.addGroup(
                desc.addShader(NriStage.ClosestHit, "MyClosestHitShader_Triangle"), -1, -1);
            const aabbClosestHit = desc.addShader(NriStage.ClosestHit, "MyClosestHitShader_AABB");
            // Each intersection shader's radiance and shadow ray hit groups.
            const aabbGroups: int[] = [];
            for (const name of INTERSECTION_SHADER_NAMES) {
                const intersection = desc.addShader(NriStage.Intersection, `MyIntersectionShader_${name}`);
                aabbGroups.push(desc.addGroup(aabbClosestHit, intersection, -1));
                aabbGroups.push(desc.addGroup(intersection, -1, -1));
            }
            const pipeline = device.createRayTracingPipelineFromDesc(layout,
                `shaders/procedural_geometry/${folder}/procedural_geometry.bin`, desc, PAYLOAD_SIZE, ATTRIBUTE_SIZE, MAX_RECURSION_DEPTH);
            desc.destroy();
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
            this.shaderTable = device.createShaderTableFromGroups(this.queue, pipeline, raygenGroup, Ref(missGroups[0]), missGroups.length,
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
        createBuffers(device: NriDevice): boolean {
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

            const indexBuffer = device.createUploadedStructuredBufferFromInts(this.queue, Ref(PLANE_INDICES[0]),
                PLANE_INDICES.length * 4, 4);
            this.indexBuffer = indexBuffer;
            const vertexBuffer = device.createUploadedStructuredBuffer(this.queue, Ref(PLANE_VERTICES[0]), PLANE_VERTICES.length * 4, 4);
            this.vertexBuffer = vertexBuffer;
            const materialBuffer = device.createUploadedStructuredBuffer(this.queue, Ref(materials[0]), materials.length * 4,
                MATERIAL_FLOATS * 4);
            this.materialBuffer = materialBuffer;
            const aabbConstantBuffer = device.createUploadedStructuredBufferFromInts(this.queue, Ref(aabbConstants[0]),
                aabbConstants.length * 4, AABB_CONSTANTS_STRIDE);
            this.aabbConstantBuffer = aabbConstantBuffer;
            if (!indexBuffer || !vertexBuffer || !materialBuffer || !aabbConstantBuffer) {
                console.log("Cannot create the scene's buffers");
                return false;
            }
            const views = [
                indexBuffer.createStructuredView(0),
                vertexBuffer.createStructuredView(0),
                materialBuffer.createStructuredView(0),
                aabbConstantBuffer.createStructuredView(0),
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
        createAccelerationStructures(device: NriDevice): boolean {
            const vertexCount = PLANE_VERTICES.length / 6;
            const positions: f32[] = [];
            for (let v = 0; v < vertexCount; v++) {
                for (let c = 0; c < 3; c++) {
                    positions.push(PLANE_VERTICES[v * 6 + c]);
                }
            }
            const planeDesc = NriBlasDesc.create();
            planeDesc.addTriangles(Ref(positions[0]), vertexCount, Ref(PLANE_INDICES[0]), PLANE_INDICES.length);
            const planeBlas = device.buildBlasFromDesc(this.queue, planeDesc, NriAccelerationStructureFlags.PreferFastTrace);
            planeDesc.destroy();
            this.planeBlas = planeBlas;

            const aabbDesc = NriBlasDesc.create();
            for (let i = 0; i < PRIMITIVE_COUNT; i++) {
                aabbDesc.addAabbs(Ref(this.aabbs[i * 6]), 1);
            }
            const aabbBlas = device.buildBlasFromDesc(this.queue, aabbDesc, NriAccelerationStructureFlags.PreferFastTrace);
            aabbDesc.destroy();
            this.aabbBlas = aabbBlas;
            if (!planeBlas || !aabbBlas) {
                console.log("Cannot build the bottom level acceleration structures");
                return false;
            }

            // BuildBotomLevelASInstanceDescs: the plane, a little larger than a 700 x 700 grid of AABBs,
            // from -0.35 of its width; the AABBs moved up onto it, their hit groups after the plane's
            // two.
            const topLevelAS = device.createTopLevelAS(2, NriAccelerationStructureFlags.PreferFastTrace, 1);
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
            topLevelAS.addInstance(planeBlas, Ref(transform[0]), 0, 1, 0, 0);
            const aabbTransform: f32[] = [
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, AABB_WIDTH / 2.0,
                0.0, 0.0, 1.0, 0.0,
            ];
            topLevelAS.addInstance(aabbBlas, Ref(aabbTransform[0]), 0, 1, RAY_TYPE_COUNT, 0);
            if (this.queue.buildTopLevelAS(topLevelAS) == 0) {
                console.log("Cannot build the top level acceleration structure");
                return false;
            }
            this.topLevelASView = topLevelAS.getTopLevelAccelerationStructure().createDescriptor();
            return true;
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // Whether the toggle key (keysDown's index) went down since the last frame.
        keyPressed(index: int, key: int): boolean {
            const down = this.sample.isKeyPressed(key) != 0;
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
        recordRays(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame, frameIndex: int) {
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
            sceneConstantBuffer.write((frameIndex % this.queuedFrames.length) * SCENE_CB_SIZE, Ref(this.sceneData[0]), SCENE_CB_SIZE);
            aabbAttributeBuffer.write(0, Ref(this.aabbAttributes[0]), this.aabbAttributes.length * 4);

            if (this.outputCopied) {
                commandBuffer.textureBarrier(output, NriTextureState.CopySource, NriTextureState.RayTracingStorage);
            }
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setRayTracingPipelineLayout(layout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setRayTracingDescriptorSet(0, set);
            commandBuffer.dispatchRays(shaderTable, this.width, this.height);
            commandBuffer.textureBarrier(output, NriTextureState.RayTracingStorage, NriTextureState.CopySource);
            this.outputCopied = true;
        }

        // CopyRaytracingOutputToBackbuffer: without conversion, as the sample's CopyResource into its
        // UNORM back buffer.
        recordCopy(commandBuffer: NriCommandBuffer, texture: NriTexture) {
            const output = this.output;
            if (output) {
                commandBuffer.copyTexture(texture, output);
            }
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrame = this.queuedFrames[frameIndex % this.queuedFrames.length];

            // Animate first, as Donut's onAnimate before onRender (its test mode steps float(1/60) s).
            this.animate(this.test ? Math.fround(1.0 / 60.0) : this.sample.getFrameTime());

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: the rays, then their output copied into the frame.
                commandBuffer.begin();
                this.recordRays(commandBuffer, queuedFrame, frameIndex);
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.CopyDestination);
                this.recordCopy(commandBuffer, texture);

                // The test's last frame: read back
                let presentFrom = NriTextureState.CopyDestination;
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    if (frameIndex == TEST_FRAMES - 1) {
                        commandBuffer.textureBarrier(texture, NriTextureState.CopyDestination, NriTextureState.CopySource);
                        commandBuffer.readbackTextureToBuffer(readbackBuffer, this.rowPitch, texture, this.width, this.height);
                        presentFrom = NriTextureState.CopySource;
                    }
                }
                commandBuffer.textureBarrier(texture, presentFrom, NriTextureState.Present);
                commandBuffer.end();

                // Submit and present
                this.swapChain.submit(commandBuffer, index);
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
                for (const queuedFrame of this.queuedFrames) {
                    this.destroyDescriptor(queuedFrame.sceneConstantsView);
                    this.destroyDescriptor(queuedFrame.aabbAttributeView);
                    this.destroyBuffer(queuedFrame.aabbAttributeBuffer);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                this.destroyDescriptor(this.outputStorage);
                for (const view of this.bufferViews) {
                    view.destroy();
                }
                this.destroyDescriptor(this.topLevelASView);
                const output = this.output;
                if (output) {
                    output.destroy();
                }
                this.destroyBuffer(this.sceneConstantBuffer);
                this.destroyBuffer(this.indexBuffer);
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.materialBuffer);
                this.destroyBuffer(this.aabbConstantBuffer);
                const topLevelAS = this.topLevelAS;
                if (topLevelAS) {
                    topLevelAS.destroy();
                }
                const planeBlas = this.planeBlas;
                if (planeBlas) {
                    planeBlas.destroy();
                }
                const aabbBlas = this.aabbBlas;
                if (aabbBlas) {
                    aabbBlas.destroy();
                }
                const shaderTable = this.shaderTable;
                if (shaderTable) {
                    shaderTable.destroy();
                }
                this.destroyBuffer(this.readbackBuffer);
                const pipeline = this.pipeline;
                if (pipeline) {
                    pipeline.destroy();
                }
                const layout = this.layout;
                if (layout) {
                    layout.destroy();
                }
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
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        const proceduralGeometry = new ProceduralGeometry(sample);
        // -benchmark: 1/60 s per frame; -time <seconds>: the geometry animation's time, fixed.
        sample.addExampleOption("-benchmark");
        sample.addExampleOptionWithValues("-time", 1);
        sample.useResizableWindow();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-benchmark") {
                proceduralGeometry.benchmark = true;
            } else if (arg == "-time" && i + 1 < argc) {
                i++;
                proceduralGeometry.fixedTime = parseFloat(Nri.getArg(argc, argv, i));
            }
        }
        return proceduralGeometry.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return ProceduralGeometryNri.main(argc, argv);
}

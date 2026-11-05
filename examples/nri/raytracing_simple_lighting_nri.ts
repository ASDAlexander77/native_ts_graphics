/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { Nri, NriAccelerationStructure, NriBlasDesc, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriPipeline, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriRayTracingPipelineDesc, NriSample, NriShaderTable, NriTexture, NriTopLevelAS } from "../../core/nri";
import {
    cross3, matrixInverse, matrixLookAtLH, matrixMultiply, matrixPerspectiveFovLH, matrixRotationY, normalize3,
    normalize4, radians, transform3, vsub,
} from "../../core/directx_math";

namespace RaytracingSimpleLightingNri {
    // raytracing_simple_lighting, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead
    // of Donut and NVRHI: the same shaders (raytracing_simple_lighting.hlsl's library), through the NRI
    // calls core/nri/nri_interop.d.ts binds. This example creates everything it runs, and does the
    // rendering.

    // Test mode: the frames rendered, each 1/60 s.
    const TEST_FRAMES = 60;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no ray tracing, or no shaders for
    // the graphics API (D3D11).
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: D3D12 Raytracing - Simple Lighting";

    // sizeof(RayPayload): float4 color; sizeof(BuiltInTriangleIntersectionAttributes); primary rays
    // only.
    const PAYLOAD_SIZE = 16;
    const ATTRIBUTE_SIZE = 8;
    const MAX_RECURSION_DEPTH = 1;

    const CUBE_CB_FLOATS = 4;
    // Constant buffers are 256-byte multiples.
    const CB_SIZE = 256;

    // BuildGeometry's cube: 24 vertices (position, normal: 24 bytes each), a face's four with the
    // face's normal, and 36 16-bit indices.
    const VERTEX_STRIDE = 24;
    const CUBE_VERTICES: f32[] = [
        -1.0, 1.0, -1.0, 0.0, 1.0, 0.0,
        1.0, 1.0, -1.0, 0.0, 1.0, 0.0,
        1.0, 1.0, 1.0, 0.0, 1.0, 0.0,
        -1.0, 1.0, 1.0, 0.0, 1.0, 0.0,

        -1.0, -1.0, -1.0, 0.0, -1.0, 0.0,
        1.0, -1.0, -1.0, 0.0, -1.0, 0.0,
        1.0, -1.0, 1.0, 0.0, -1.0, 0.0,
        -1.0, -1.0, 1.0, 0.0, -1.0, 0.0,

        -1.0, -1.0, 1.0, -1.0, 0.0, 0.0,
        -1.0, -1.0, -1.0, -1.0, 0.0, 0.0,
        -1.0, 1.0, -1.0, -1.0, 0.0, 0.0,
        -1.0, 1.0, 1.0, -1.0, 0.0, 0.0,

        1.0, -1.0, 1.0, 1.0, 0.0, 0.0,
        1.0, -1.0, -1.0, 1.0, 0.0, 0.0,
        1.0, 1.0, -1.0, 1.0, 0.0, 0.0,
        1.0, 1.0, 1.0, 1.0, 0.0, 0.0,

        -1.0, -1.0, -1.0, 0.0, 0.0, -1.0,
        1.0, -1.0, -1.0, 0.0, 0.0, -1.0,
        1.0, 1.0, -1.0, 0.0, 0.0, -1.0,
        -1.0, 1.0, -1.0, 0.0, 0.0, -1.0,

        -1.0, -1.0, 1.0, 0.0, 0.0, 1.0,
        1.0, -1.0, 1.0, 0.0, 0.0, 1.0,
        1.0, 1.0, 1.0, 0.0, 0.0, 1.0,
        -1.0, 1.0, 1.0, 0.0, 0.0, 1.0,
    ];
    const CUBE_INDICES: int[] = [
        3, 1, 0,
        2, 1, 3,

        6, 4, 5,
        7, 4, 6,

        11, 9, 8,
        10, 9, 11,

        14, 12, 13,
        15, 12, 14,

        19, 17, 16,
        18, 17, 19,

        22, 20, 21,
        23, 20, 22,
    ];

    // The pipeline's shader groups (NriRayTracingPipelineDesc.addGroup's order).
    const RAYGEN_GROUP = 0;
    const MISS_GROUP = 1;
    const HIT_GROUP = 2;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // A frame in flight's own data: its scene constants' set.
    class QueuedFrame {
        constructor(public sceneConstantsView: NriDescriptor | null, public set: NriDescriptorSet | null) {
        }
    }

    // -test: checks the last frame, read back, as the Donut example does. The background (the miss
    // shader's (0, 0.2, 0.4)) around the cube in the middle; the cube's faces ambient gray (0.5) at
    // least, the lit ones reddened by the diffuse light.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const background = 0 | (51 << 8) | (102 << 16);
        const corner = pixels[0] & 0xFFFFFF;
        if (corner != background) {
            return `the corner pixel is ${corner & 0xFF}, ${(corner >> 8) & 0xFF}, ${(corner >> 16) & 0xFF}, not the background`;
        }
        const center = pixels[Math.floor(height / 2) * width + Math.floor(width / 2)] & 0xFFFFFF;
        if (center == background) {
            return "the frame's center shows the background, not the cube";
        }
        let cube = 0;
        let reddened = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i] & 0xFFFFFF;
            if (p == background) {
                continue;
            }
            cube++;
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            if (r > g + 16) {
                reddened++;
            }
        }
        const coverage = cube / (width * height);
        const reddenedFraction = reddened / (width * height);
        console.log(`Coverage ${coverage}, reddened ${reddenedFraction}`);
        if (coverage < 0.05 || coverage > 0.6) {
            return `the cube covers ${coverage} of the frame`;
        }
        if (reddenedFraction < 0.01) {
            return `only ${reddenedFraction} of the frame is lit by the red diffuse light`;
        }
        return "";
    }

    // Port of DirectX-Graphics-Samples' D3D12RaytracingSimpleLighting, as
    // examples/raytracing_simple_lighting.ts ports it, to NRI: a cube ray traced, lit by a point light
    // (ambient plus red diffuse light), the camera circling it once in 24 s and the light the other way
    // once in 8 s. The closest hit shader finds the hit triangle's vertex normals through its 16-bit
    // indices, read from a ByteAddressBuffer (a structured view of 4-byte elements here), and
    // interpolates them with the hit's barycentrics. The sample's local root constants (the cube's
    // albedo) are a constant buffer; the output, in the back buffer's format, is copied into it.
    class RaytracingSimpleLighting {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private layout: NriPipelineLayout | null = null;
        private pipeline: NriPipeline | null = null;
        private shaderTable: NriShaderTable | null = null;
        private blas: NriAccelerationStructure | null = null;
        private topLevelAS: NriTopLevelAS | null = null;
        private topLevelASView: NriDescriptor | null = null;
        // The cube's vertices (stride 24) and 16-bit indices (two per 4-byte element), as the closest
        // hit shader reads them.
        private vertexBuffer: NriBuffer | null = null;
        private vertexBufferView: NriDescriptor | null = null;
        private indexBuffer: NriBuffer | null = null;
        private indexBufferView: NriDescriptor | null = null;
        // The scene constants, CB_SIZE bytes a frame in flight; the cube's.
        private sceneConstantBuffer: NriBuffer | null = null;
        private cubeConstantBuffer: NriBuffer | null = null;
        private cubeConstantsView: NriDescriptor | null = null;
        private output: NriTexture | null = null;
        private outputStorage: NriDescriptor | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        // The output was copied from (after the first frame).
        private outputCopied: boolean = false;
        // The swap chain's size (the window's when it was made) and its textures' format.
        private width: int = 0;
        private height: int = 0;
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        // InitializeScene's camera and light.
        private eye: number[] = [];
        private at: number[] = [];
        private up: number[] = [];
        private lightPosition: number[] = [0.0, Math.fround(1.8), -3.0, 0.0];
        private sceneData: f32[] = [];
        private cubeData: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
            for (let i = 0; i < CB_SIZE / 4; i++) {
                this.sceneData.push(0.0);
                this.cubeData.push(0.0);
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

            // Swap chain: copied into, in its own (UNORM) format, as the sample's CopyResource.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, false);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;

            // Queued frames (their sets come below)
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                this.queuedFrames.push(new QueuedFrame(null, null));
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

            // CreateRootSignatures' global root signature, and the local one's constants (b1): the scene
            // (t0), the output (u0), the indices and the vertices (t1, t2), the scene's and the cube's
            // constants (b0, b1).
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.AccelerationStructure, NriStage.RayTracing, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.StorageTexture, NriStage.RayTracing, NriRangeFlags.None);
            layoutDesc.addRange(0, 1, 2, NriDescriptorType.StructuredBuffer, NriStage.RayTracing, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 2, NriDescriptorType.ConstantBuffer, NriStage.RayTracing, NriRangeFlags.None);
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
            if (!this.createAccelerationStructures(device)) {
                return 0;
            }

            // InitializeScene's camera: from (0, 2, -5) towards the origin, its up vector
            // perpendicular to the view direction and x, both turned 45 degrees about y.
            this.eye = [0.0, 2.0, -5.0, 1.0];
            this.at = [0.0, 0.0, 0.0, 1.0];
            const direction = normalize4(vsub(this.at, this.eye));
            this.up = normalize3(cross3(direction, [1.0, 0.0, 0.0, 0.0]));
            const rotate = matrixRotationY(radians(45.0));
            this.eye = transform3(this.eye, rotate);
            this.up = transform3(this.up, rotate);

            // The scene constants, written every frame into the frame's part; the cube's, written once:
            // its albedo, white.
            const sceneConstantBuffer = device.createHostBuffer(CB_SIZE * queuedFrameNum, NriBufferUsage.ConstantBuffer);
            this.sceneConstantBuffer = sceneConstantBuffer;
            const cubeConstantBuffer = device.createHostBuffer(CB_SIZE, NriBufferUsage.ConstantBuffer);
            this.cubeConstantBuffer = cubeConstantBuffer;
            if (!sceneConstantBuffer || !cubeConstantBuffer) {
                console.log("Cannot create the constant buffers");
                return 0;
            }
            for (let i = 0; i < CUBE_CB_FLOATS; i++) {
                this.cubeData[i] = 1.0;
            }
            cubeConstantBuffer.write(0, Ref(this.cubeData[0]), CB_SIZE);
            const cubeConstantsView = cubeConstantBuffer.createConstantView(0, CB_SIZE);
            this.cubeConstantsView = cubeConstantsView;

            // The output the ray generation shader writes, in the back buffer's format, for the copy.
            const outputCreated = this.createOutput(device);
            const descriptorPool = device.createDescriptorPoolWithAccelerationStructures(queuedFrameNum, 0, 2 * queuedFrameNum, 0,
                queuedFrameNum, 2 * queuedFrameNum, queuedFrameNum);
            this.descriptorPool = descriptorPool;
            const topLevelASView = this.topLevelASView;
            const vertexBufferView = this.vertexBufferView;
            const indexBufferView = this.indexBufferView;
            if (!outputCreated || !descriptorPool || !topLevelASView || !vertexBufferView || !indexBufferView || !cubeConstantsView) {
                console.log("Cannot create the output");
                return 0;
            }
            const outputStorage = this.outputStorage;
            if (!outputStorage) {
                console.log("Cannot create the output's view");
                return 0;
            }

            // A set per frame in flight: its own part of the scene constants.
            for (let i = 0; i < queuedFrameNum; i++) {
                const queuedFrame = this.queuedFrames[i];
                const sceneConstantsView = sceneConstantBuffer.createConstantView(i * CB_SIZE, CB_SIZE);
                queuedFrame.sceneConstantsView = sceneConstantsView;
                const set = descriptorPool.allocateDescriptorSet(layout, 0, 0);
                queuedFrame.set = set;
                if (!set || !sceneConstantsView) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                set.updateDescriptor(0, 0, topLevelASView);
                set.updateDescriptor(1, 0, outputStorage);
                set.updateDescriptor(2, 0, indexBufferView);
                set.updateDescriptor(2, 1, vertexBufferView);
                set.updateDescriptor(3, 0, sceneConstantsView);
                set.updateDescriptor(3, 1, cubeConstantsView);
            }

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // CreateRaytracingPipelineStateObject and BuildShaderTables: the ray generation shader, the
        // miss shader, the hit group of the closest hit shader. False (after printing why) on failure.
        createRayTracingPipeline(device: NriDevice, layout: NriPipelineLayout, folder: string): boolean {
            const desc = NriRayTracingPipelineDesc.create();
            desc.addGroup(desc.addShader(NriStage.RayGen, "MyRaygenShader"), -1, -1);
            desc.addGroup(desc.addShader(NriStage.Miss, "MyMissShader"), -1, -1);
            desc.addGroup(desc.addShader(NriStage.ClosestHit, "MyClosestHitShader"), -1, -1);
            const pipeline = device.createRayTracingPipelineFromDesc(layout,
                `shaders/raytracing_simple_lighting/${folder}/raytracing_simple_lighting.bin`, desc, PAYLOAD_SIZE, ATTRIBUTE_SIZE,
                MAX_RECURSION_DEPTH);
            desc.destroy();
            this.pipeline = pipeline;
            if (!pipeline) {
                console.log("Cannot initialize the ray tracing pipeline");
                return false;
            }

            const missGroups: int[] = [MISS_GROUP];
            const hitGroups: int[] = [HIT_GROUP];
            this.shaderTable = device.createShaderTableFromGroups(this.queue, pipeline, RAYGEN_GROUP, Ref(missGroups[0]), missGroups.length,
                Ref(hitGroups[0]), hitGroups.length);
            if (!this.shaderTable) {
                console.log("Cannot create the shader table");
                return false;
            }
            return true;
        }

        // BuildGeometry and BuildAccelerationStructures: the cube's vertex and index buffers (which the
        // closest hit shader reads), its BLAS (preferring fast tracing; its positions and indices given
        // apart, as the BLAS desc takes them) and the TLAS's one instance (identity transform, mask 1),
        // built once: it doesn't move. False (after printing why) on failure.
        createAccelerationStructures(device: NriDevice): boolean {
            const vertexCount = CUBE_VERTICES.length / 6;
            // Two 16-bit indices per int.
            const packedIndices: int[] = [];
            for (let i = 0; i < CUBE_INDICES.length; i += 2) {
                packedIndices.push(CUBE_INDICES[i] | (CUBE_INDICES[i + 1] << 16));
            }
            const vertexBuffer = device.createUploadedStructuredBuffer(this.queue, Ref(CUBE_VERTICES[0]), CUBE_VERTICES.length * 4,
                VERTEX_STRIDE);
            this.vertexBuffer = vertexBuffer;
            const indexBuffer = device.createUploadedStructuredBufferFromInts(this.queue, Ref(packedIndices[0]), CUBE_INDICES.length * 2, 4);
            this.indexBuffer = indexBuffer;
            if (!vertexBuffer || !indexBuffer) {
                console.log("Cannot create the cube's buffers");
                return false;
            }
            this.vertexBufferView = vertexBuffer.createStructuredView(0);
            this.indexBufferView = indexBuffer.createStructuredView(0);

            const positions: f32[] = [];
            for (let v = 0; v < vertexCount; v++) {
                for (let c = 0; c < 3; c++) {
                    positions.push(CUBE_VERTICES[v * 6 + c]);
                }
            }
            const desc = NriBlasDesc.create();
            desc.addTriangles(Ref(positions[0]), vertexCount, Ref(CUBE_INDICES[0]), CUBE_INDICES.length);
            const blas = device.buildBlasFromDesc(this.queue, desc, NriAccelerationStructureFlags.PreferFastTrace);
            desc.destroy();
            this.blas = blas;
            if (!blas) {
                console.log("Cannot build the bottom level acceleration structure");
                return false;
            }

            const topLevelAS = device.createTopLevelAS(1, NriAccelerationStructureFlags.PreferFastTrace, 1);
            this.topLevelAS = topLevelAS;
            if (!topLevelAS) {
                console.log("Cannot create the top level acceleration structure");
                return false;
            }
            const transform: f32[] = [
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0,
            ];
            topLevelAS.addInstance(blas, Ref(transform[0]), 0, 1, 0, 0);
            if (this.queue.buildTopLevelAS(topLevelAS) == 0) {
                console.log("Cannot build the top level acceleration structure");
                return false;
            }
            this.topLevelASView = topLevelAS.getTopLevelAccelerationStructure().createDescriptor();
            return true;
        }

        // The swap chain's size and formats (its views in the textures' format).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
        }

        // The output at the swap chain's size and format and its storage view, not written yet (in
        // NriTextureState.Storage, as created: no barrier before its first rays). False on failure.
        createOutput(device: NriDevice): boolean {
            const output = device.createStorageTexture(this.queue, this.width, this.height, this.swapChainFormat);
            this.output = output;
            this.outputCopied = false;
            if (!output) {
                return false;
            }
            this.outputStorage = output.createStorageView(this.swapChainFormat);
            return true;
        }

        destroyOutput() {
            this.destroyDescriptor(this.outputStorage);
            this.outputStorage = null;
            const output = this.output;
            if (output) {
                output.destroy();
            }
            this.output = null;
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain and the output (when the
        // example runs) made again at its size, once the GPU is done with the old ones, the frames'
        // sets pointed at the new output.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (!this.swapChain.resized()) {
                return;
            }
            device.waitIdle();
            let hadOutput = false;
            if (this.output) {
                hadOutput = true;
            }
            this.destroyOutput();
            this.swapChain.recreate();
            this.sizeToSwapChain();
            if (hadOutput) {
                this.createOutput(device);
                const outputStorage = this.outputStorage;
                if (outputStorage) {
                    for (const queuedFrame of this.queuedFrames) {
                        const set = queuedFrame.set;
                        if (set) {
                            set.updateDescriptor(1, 0, outputStorage);
                        }
                    }
                }
            }
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // OnUpdate: the camera circles the cube about y once in 24 s, the light the other way once in
        // 8 s.
        animate(elapsedSeconds: number) {
            const elapsedTime = Math.fround(elapsedSeconds);
            {
                const angleToRotateBy = Math.fround(360.0 * Math.fround(elapsedTime / 24.0));
                const rotate = matrixRotationY(radians(angleToRotateBy));
                this.eye = transform3(this.eye, rotate);
                this.up = transform3(this.up, rotate);
                this.at = transform3(this.at, rotate);
            }
            {
                const angleToRotateBy = Math.fround(-360.0 * Math.fround(elapsedTime / 8.0));
                const rotate = matrixRotationY(radians(angleToRotateBy));
                this.lightPosition = transform3(this.lightPosition, rotate);
            }
        }

        // UpdateCameraMatrices: projectionToWorld, the inverse of the view-projection matrix (45 degrees
        // vertically, depth 1 to 125), and the camera position; the light.
        writeSceneConstants(width: int, height: int) {
            const view = matrixLookAtLH(this.eye, this.at, this.up);
            const aspectRatio = Math.fround(Math.fround(width) / Math.fround(height));
            const proj = matrixPerspectiveFovLH(radians(45.0), aspectRatio, 1.0, 125.0);
            const projectionToWorld = matrixInverse(matrixMultiply(view, proj));
            for (let i = 0; i < 16; i++) {
                this.sceneData[i] = projectionToWorld[i];
            }
            for (let i = 0; i < 4; i++) {
                this.sceneData[16 + i] = this.eye[i];
                this.sceneData[20 + i] = this.lightPosition[i];
            }
            // lightAmbientColor (0.5, 0.5, 0.5, 1), lightDiffuseColor (0.5, 0, 0, 1).
            this.sceneData[24] = 0.5;
            this.sceneData[25] = 0.5;
            this.sceneData[26] = 0.5;
            this.sceneData[27] = 1.0;
            this.sceneData[28] = 0.5;
            this.sceneData[29] = 0.0;
            this.sceneData[30] = 0.0;
            this.sceneData[31] = 1.0;
        }

        // DoRaytracing: the scene constants (into the frame's part), then the rays into the output,
        // which then goes to the copy.
        recordRays(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame, frameIndex: int) {
            const layout = this.layout;
            const pipeline = this.pipeline;
            const shaderTable = this.shaderTable;
            const descriptorPool = this.descriptorPool;
            const set = queuedFrame.set;
            const output = this.output;
            const sceneConstantBuffer = this.sceneConstantBuffer;
            if (!layout || !pipeline || !shaderTable || !descriptorPool || !set || !output || !sceneConstantBuffer) {
                return;
            }
            this.writeSceneConstants(this.width, this.height);
            sceneConstantBuffer.write((frameIndex % this.queuedFrames.length) * CB_SIZE, Ref(this.sceneData[0]), CB_SIZE);

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
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                this.destroyOutput();
                this.destroyDescriptor(this.cubeConstantsView);
                this.destroyDescriptor(this.vertexBufferView);
                this.destroyDescriptor(this.indexBufferView);
                this.destroyDescriptor(this.topLevelASView);
                this.destroyBuffer(this.sceneConstantBuffer);
                this.destroyBuffer(this.cubeConstantBuffer);
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.indexBuffer);
                const topLevelAS = this.topLevelAS;
                if (topLevelAS) {
                    topLevelAS.destroy();
                }
                const blas = this.blas;
                if (blas) {
                    blas.destroy();
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
        sample.useResizableWindow();
        return new RaytracingSimpleLighting(sample).run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return RaytracingSimpleLightingNri.main(argc, argv);
}

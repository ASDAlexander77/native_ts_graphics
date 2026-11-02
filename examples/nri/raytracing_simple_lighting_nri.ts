/// <reference path="../../core/nri/nri_interop.d.ts" />
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

    // The pipeline's shader groups (Nri_RayTracingPipelineDescAddGroup's order).
    const RAYGEN_GROUP = 0;
    const MISS_GROUP = 1;
    const HIT_GROUP = 2;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into, and its scene constants' set.
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public sceneConstantsView: NriDescriptorHandle | null, public set: NriDescriptorSetHandle | null) {
        }
    }

    // A swap chain texture and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
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
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private layout: NriPipelineLayoutHandle | null = null;
        private pipeline: NriPipelineHandle | null = null;
        private shaderTable: NriShaderTableHandle | null = null;
        private blas: NriAccelerationStructureHandle | null = null;
        private topLevelAS: NriTopLevelASHandle | null = null;
        private topLevelASView: NriDescriptorHandle | null = null;
        // The cube's vertices (stride 24) and 16-bit indices (two per 4-byte element), as the closest
        // hit shader reads them.
        private vertexBuffer: NriBufferHandle | null = null;
        private vertexBufferView: NriDescriptorHandle | null = null;
        private indexBuffer: NriBufferHandle | null = null;
        private indexBufferView: NriDescriptorHandle | null = null;
        // The scene constants, CB_SIZE bytes a frame in flight; the cube's.
        private sceneConstantBuffer: NriBufferHandle | null = null;
        private cubeConstantBuffer: NriBufferHandle | null = null;
        private cubeConstantsView: NriDescriptorHandle | null = null;
        private output: NriTextureHandle | null = null;
        private outputStorage: NriDescriptorHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        // The output was copied from (after the first frame).
        private outputCopied: boolean = false;
        private width: int = 0;
        private height: int = 0;
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
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
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
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), null, null));
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

            // CreateRootSignatures' global root signature, and the local one's constants (b1): the scene
            // (t0), the output (u0), the indices and the vertices (t1, t2), the scene's and the cube's
            // constants (b0, b1).
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.AccelerationStructure, NriStage.RayTracing, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.StorageTexture, NriStage.RayTracing, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 1, 2, NriDescriptorType.StructuredBuffer, NriStage.RayTracing, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 2, NriDescriptorType.ConstantBuffer, NriStage.RayTracing, NriRangeFlags.None);
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
            const sceneConstantBuffer = Nri_CreateHostBuffer(device, CB_SIZE * queuedFrameNum, NriBufferUsage.ConstantBuffer);
            this.sceneConstantBuffer = sceneConstantBuffer;
            const cubeConstantBuffer = Nri_CreateHostBuffer(device, CB_SIZE, NriBufferUsage.ConstantBuffer);
            this.cubeConstantBuffer = cubeConstantBuffer;
            if (!sceneConstantBuffer || !cubeConstantBuffer) {
                console.log("Cannot create the constant buffers");
                return 0;
            }
            for (let i = 0; i < CUBE_CB_FLOATS; i++) {
                this.cubeData[i] = 1.0;
            }
            Nri_WriteBuffer(cubeConstantBuffer, 0, Ref(this.cubeData[0]), CB_SIZE);
            const cubeConstantsView = Nri_CreateConstantBufferView(cubeConstantBuffer, 0, CB_SIZE);
            this.cubeConstantsView = cubeConstantsView;

            // The output the ray generation shader writes, in the back buffer's format, for the copy.
            const output = Nri_CreateStorageTexture(device, this.queue, this.width, this.height, format);
            this.output = output;
            const descriptorPool = Nri_CreateDescriptorPoolWithAccelerationStructures(device, queuedFrameNum, 0, 2 * queuedFrameNum, 0,
                queuedFrameNum, 2 * queuedFrameNum, queuedFrameNum);
            this.descriptorPool = descriptorPool;
            const topLevelASView = this.topLevelASView;
            const vertexBufferView = this.vertexBufferView;
            const indexBufferView = this.indexBufferView;
            if (!output || !descriptorPool || !topLevelASView || !vertexBufferView || !indexBufferView || !cubeConstantsView) {
                console.log("Cannot create the output");
                return 0;
            }
            const outputStorage = Nri_CreateStorageTextureView(output, format);
            this.outputStorage = outputStorage;
            if (!outputStorage) {
                console.log("Cannot create the output's view");
                return 0;
            }

            // A set per frame in flight: its own part of the scene constants.
            for (let i = 0; i < queuedFrameNum; i++) {
                const queuedFrame = this.queuedFrames[i];
                const sceneConstantsView = Nri_CreateConstantBufferView(sceneConstantBuffer, i * CB_SIZE, CB_SIZE);
                queuedFrame.sceneConstantsView = sceneConstantsView;
                const set = Nri_AllocateDescriptorSet(descriptorPool, layout, 0, 0);
                queuedFrame.set = set;
                if (!set || !sceneConstantsView) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(set, 0, 0, topLevelASView);
                Nri_UpdateDescriptor(set, 1, 0, outputStorage);
                Nri_UpdateDescriptor(set, 2, 0, indexBufferView);
                Nri_UpdateDescriptor(set, 2, 1, vertexBufferView);
                Nri_UpdateDescriptor(set, 3, 0, sceneConstantsView);
                Nri_UpdateDescriptor(set, 3, 1, cubeConstantsView);
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
        // miss shader, the hit group of the closest hit shader. False (after printing why) on failure.
        createRayTracingPipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, folder: string): boolean {
            const desc = Nri_CreateRayTracingPipelineDesc();
            Nri_RayTracingPipelineDescAddGroup(desc, Nri_RayTracingPipelineDescAddShader(desc, NriStage.RayGen, "MyRaygenShader"), -1, -1);
            Nri_RayTracingPipelineDescAddGroup(desc, Nri_RayTracingPipelineDescAddShader(desc, NriStage.Miss, "MyMissShader"), -1, -1);
            Nri_RayTracingPipelineDescAddGroup(desc, Nri_RayTracingPipelineDescAddShader(desc, NriStage.ClosestHit, "MyClosestHitShader"), -1, -1);
            const pipeline = Nri_CreateRayTracingPipelineFromDesc(device, layout,
                `shaders/raytracing_simple_lighting/${folder}/raytracing_simple_lighting.bin`, desc, PAYLOAD_SIZE, ATTRIBUTE_SIZE,
                MAX_RECURSION_DEPTH);
            Nri_DestroyRayTracingPipelineDesc(desc);
            this.pipeline = pipeline;
            if (!pipeline) {
                console.log("Cannot initialize the ray tracing pipeline");
                return false;
            }

            const missGroups: int[] = [MISS_GROUP];
            const hitGroups: int[] = [HIT_GROUP];
            this.shaderTable = Nri_CreateShaderTableFromGroups(device, this.queue, pipeline, RAYGEN_GROUP, Ref(missGroups[0]), missGroups.length,
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
        createAccelerationStructures(device: NriDeviceHandle): boolean {
            const vertexCount = CUBE_VERTICES.length / 6;
            // Two 16-bit indices per int.
            const packedIndices: int[] = [];
            for (let i = 0; i < CUBE_INDICES.length; i += 2) {
                packedIndices.push(CUBE_INDICES[i] | (CUBE_INDICES[i + 1] << 16));
            }
            const vertexBuffer = Nri_CreateUploadedStructuredBuffer(device, this.queue, Ref(CUBE_VERTICES[0]), CUBE_VERTICES.length * 4,
                VERTEX_STRIDE);
            this.vertexBuffer = vertexBuffer;
            const indexBuffer = Nri_CreateUploadedStructuredBufferFromInts(device, this.queue, Ref(packedIndices[0]), CUBE_INDICES.length * 2, 4);
            this.indexBuffer = indexBuffer;
            if (!vertexBuffer || !indexBuffer) {
                console.log("Cannot create the cube's buffers");
                return false;
            }
            this.vertexBufferView = Nri_CreateStructuredBufferView(vertexBuffer, 0);
            this.indexBufferView = Nri_CreateStructuredBufferView(indexBuffer, 0);

            const positions: f32[] = [];
            for (let v = 0; v < vertexCount; v++) {
                for (let c = 0; c < 3; c++) {
                    positions.push(CUBE_VERTICES[v * 6 + c]);
                }
            }
            const desc = Nri_CreateBlasDesc();
            Nri_BlasDescAddTriangles(desc, Ref(positions[0]), vertexCount, Ref(CUBE_INDICES[0]), CUBE_INDICES.length);
            const blas = Nri_BuildBlasFromDesc(device, this.queue, desc, NriAccelerationStructureFlags.PreferFastTrace);
            Nri_DestroyBlasDesc(desc);
            this.blas = blas;
            if (!blas) {
                console.log("Cannot build the bottom level acceleration structure");
                return false;
            }

            const topLevelAS = Nri_CreateTopLevelAS(device, 1, NriAccelerationStructureFlags.PreferFastTrace, 1);
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
            Nri_TopLevelASAddInstance(topLevelAS, blas, Ref(transform[0]), 0, 1, 0, 0);
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
        recordRays(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame, frameIndex: int) {
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
            Nri_WriteBuffer(sceneConstantBuffer, (frameIndex % this.queuedFrames.length) * CB_SIZE, Ref(this.sceneData[0]), CB_SIZE);

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
                this.destroyDescriptor(this.cubeConstantsView);
                this.destroyDescriptor(this.vertexBufferView);
                this.destroyDescriptor(this.indexBufferView);
                this.destroyDescriptor(this.topLevelASView);
                const output = this.output;
                if (output) {
                    Nri_DestroyTexture(output);
                }
                this.destroyBuffer(this.sceneConstantBuffer);
                this.destroyBuffer(this.cubeConstantBuffer);
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.indexBuffer);
                const topLevelAS = this.topLevelAS;
                if (topLevelAS) {
                    Nri_DestroyTopLevelAS(topLevelAS);
                }
                const blas = this.blas;
                if (blas) {
                    Nri_DestroyAccelerationStructure(blas);
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
        return new RaytracingSimpleLighting(sample).run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return RaytracingSimpleLightingNri.main(argc, argv);
}

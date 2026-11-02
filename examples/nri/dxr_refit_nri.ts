/// <reference path="../../core/nri/nri_interop.d.ts" />

namespace DxrRefitNri {
    // dxr_refit, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut and
    // NVRHI: the same shaders (dxr_refit.hlsl's library), through the NRI calls
    // core/nri/nri_interop.d.ts binds. This example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no ray tracing, or no shaders for
    // the graphics API (D3D11).
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: DXR Refit";
    // The tutorial's 1920 x 1200 aspect ratio, in the Donut example's window.
    const WINDOW_WIDTH = 1280;
    const WINDOW_HEIGHT = 800;

    // struct RayPayload { float3 color; } (the shadow rays' uint payload is smaller), and the
    // triangles' float2 barycentrics.
    const PAYLOAD_SIZE = 12;
    const ATTRIBUTE_SIZE = 8;
    // One TraceRay() from the ray generation shader, one from the plane's closest hit shader.
    const MAX_RECURSION_DEPTH = 2;

    // The sky (the miss shader's color, sRGB-encoded by the ray generation shader) and the lit floor,
    // as test_check's rgb() reads them (0xBBGGRR).
    const SKY = 0x7CCBAA;
    const FLOOR = 0xF3F3F3;

    // The tutorial's createTriangleVB and createPlaneVB.
    const TRIANGLE_VERTICES: f32[] = [
        0.0, 1.0, 0.0,
        0.866, -0.5, 0.0,
        -0.866, -0.5, 0.0,
    ];
    const PLANE_VERTICES: f32[] = [
        -100.0, -1.0, -2.0,
        100.0, -1.0, 100.0,
        -100.0, -1.0, 100.0,

        -100.0, -1.0, -2.0,
        100.0, -1.0, -2.0,
        100.0, -1.0, 100.0,
    ];

    // The tutorial's createConstantBuffers: the colors A, B, C of each instance's triangle corners.
    const INSTANCE_COLORS: f32[] = [
        // Instance 0
        1.0, 0.0, 0.0, 1.0,
        1.0, 1.0, 0.0, 1.0,
        1.0, 0.0, 1.0, 1.0,
        // Instance 1
        0.0, 1.0, 0.0, 1.0,
        0.0, 1.0, 1.0, 1.0,
        1.0, 1.0, 0.0, 1.0,
        // Instance 2
        0.0, 0.0, 1.0, 1.0,
        1.0, 0.0, 1.0, 1.0,
        0.0, 1.0, 1.0, 1.0,
    ];
    // A constant buffer view's size is a multiple of 256 bytes (D3D12).
    const COLOR_BUFFER_SIZE = 256;

    // The pipeline's shader groups (Nri_RayTracingPipelineDescAddGroup's order).
    const RAYGEN_GROUP = 0;
    const MISS_GROUP = 1;
    const SHADOW_MISS_GROUP = 2;
    const TRIANGLE_HIT_GROUP = 3;
    const PLANE_HIT_GROUP = 4;
    const SHADOW_HIT_GROUP = 5;

    // Each instance's first hit entry (its hit group offset); the plane is instance 0's second
    // geometry, two entries (primary ray, shadow ray) after its triangle's.
    const INSTANCE_HIT_GROUPS = [0, 4, 6];
    // Instances 1 and 2 stand at these x, rotating about y.
    const INSTANCE_X = [0.0, -2.0, 2.0];

    // The tutorial adds 0.005 radians a frame (unthrottled, so at any rate); here 0.005 per 1/60
    // second, as the Donut example.
    const ROTATION_STEP = 0.005;
    const STEPS_PER_SECOND = 60.0;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into.
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle) {
        }
    }

    // A swap chain texture and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // -test: checks the last frame, read back, as the Donut example does: the green sky at the top
    // corners, the white floor (about 41% of the frame), and a ray traced triangle (refitted every
    // frame) in the middle.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        if ((pixels[0] & 0xFFFFFF) != SKY || (pixels[width - 1] & 0xFFFFFF) != SKY) {
            return "the top corners aren't the sky";
        }
        const middle = pixels[Math.floor(height / 2) * width + Math.floor(width / 2)] & 0xFFFFFF;
        if (middle == SKY || middle == FLOOR) {
            return "no triangle in the middle";
        }
        let floor = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i];
            if ((p & 0xFF) >= 221 && ((p >> 8) & 0xFF) >= 221 && ((p >> 16) & 0xFF) >= 221) {
                floor++;
            }
        }
        const total = width * height;
        const percent = 100.0 * floor / total;
        console.log(`Floor: ${percent}% (${floor} of ${total} pixels)`);
        if (percent < 32.0 || percent > 50.0) {
            return `Floor: ${percent}% of the pixels, not 32% to 50%`;
        }
        return "";
    }

    // Port of NVIDIA's DXR tutorial 14 (Refit), as examples/dxr_refit.ts ports it, to NRI: the scene
    // of tutorials 8-13 (a triangle and a plane in one BLAS, two more triangle instances; per-instance
    // colors; shadow rays from the plane) whose TLAS is refitted in place (built with AllowUpdate,
    // updated in the frame's command buffer) every frame as instances 1 and 2 rotate. The rays write
    // the back buffer's format, copied into it.
    class DxrRefit {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private layout: NriPipelineLayoutHandle | null = null;
        private pipeline: NriPipelineHandle | null = null;
        private shaderTable: NriShaderTableHandle | null = null;
        // The triangle and the plane, the triangle alone.
        private blases: NriAccelerationStructureHandle[] = [];
        private topLevelAS: NriTopLevelASHandle | null = null;
        private topLevelASView: NriDescriptorHandle | null = null;
        private colorBuffer: NriBufferHandle | null = null;
        private colorBufferView: NriDescriptorHandle | null = null;
        private output: NriTextureHandle | null = null;
        private outputStorage: NriDescriptorHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private set: NriDescriptorSetHandle | null = null;
        // The output was copied from (after the first frame).
        private outputCopied: boolean = false;
        // A row-major 3x4 instance transform.
        private transform: f32[] = [];
        private rotation: number = 0.0;
        private width: int = 0;
        private height: int = 0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        // -benchmark: 0.005 radians a frame, as the tutorial (for comparisons); -rebuild: build the
        // TLAS anew every frame instead of refitting it.
        benchmark: boolean = false;
        rebuild: boolean = false;

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < 12; i++) {
                this.transform.push(0.0);
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
            Nri_SetWindowSize(this.sample, WINDOW_WIDTH, WINDOW_HEIGHT);

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

            // Swap chain: copied into, in its own (UNORM) format: the shader writes sRGB-encoded
            // values, as the tutorial's CopyResource into its sRGB back buffer.
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.swapChain = Nri_CreateSwapChain(this.sample, device, this.queue, queuedFrameNum + 1);
            const textureNum = Nri_GetSwapChainTextureNum(this.swapChain);
            const format = Nri_GetTextureFormat(Nri_GetSwapChainTexture(this.swapChain, 0));
            for (let i = 0; i < textureNum; i++) {
                this.swapChainTextures.push(new SwapChainTexture(Nri_GetSwapChainTexture(this.swapChain, i),
                    Nri_CreateSwapChainSemaphore(device), Nri_CreateSwapChainSemaphore(device)));
            }

            // Queued frames
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator)));
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

            // The layout: the scene (t0), the output (u0) and the instances' colors (b0), for every
            // ray tracing stage (the plane's closest hit shader traces shadow rays).
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.AccelerationStructure, NriStage.RayTracing, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.StorageTexture, NriStage.RayTracing, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.RayTracing, NriRangeFlags.None);
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
            if (!this.createAccelerationStructures(device, queuedFrameNum)) {
                return 0;
            }

            // The instances' colors, written once.
            const colorBuffer = Nri_CreateHostBuffer(device, COLOR_BUFFER_SIZE, NriBufferUsage.ConstantBuffer);
            this.colorBuffer = colorBuffer;
            if (!colorBuffer) {
                console.log("Cannot create the color buffer");
                return 0;
            }
            Nri_WriteBuffer(colorBuffer, 0, Ref(INSTANCE_COLORS[0]), INSTANCE_COLORS.length * 4);
            const colorBufferView = Nri_CreateConstantBufferView(colorBuffer, 0, COLOR_BUFFER_SIZE);
            this.colorBufferView = colorBufferView;

            // The output the ray generation shader writes, in the back buffer's format, for the copy.
            const output = Nri_CreateStorageTexture(device, this.queue, this.width, this.height, format);
            this.output = output;
            const descriptorPool = Nri_CreateDescriptorPoolWithAccelerationStructures(device, 1, 0, 1, 0, 1, 0, 1);
            this.descriptorPool = descriptorPool;
            const topLevelASView = this.topLevelASView;
            if (!output || !descriptorPool || !topLevelASView || !colorBufferView) {
                console.log("Cannot create the output");
                return 0;
            }
            const outputStorage = Nri_CreateStorageTextureView(output, format);
            this.outputStorage = outputStorage;
            const set = Nri_AllocateDescriptorSet(descriptorPool, layout, 0, 0);
            this.set = set;
            if (!set) {
                console.log("Cannot create the descriptor set");
                return 0;
            }
            Nri_UpdateDescriptor(set, 0, 0, topLevelASView);
            Nri_UpdateDescriptor(set, 1, 0, outputStorage);
            Nri_UpdateDescriptor(set, 2, 0, colorBufferView);

            if (this.test) {
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The tutorial's createRtPipelineState and createShaderTable: the ray generation shader, the
        // primary and shadow miss shaders, the triangle, plane and shadow hit groups; the hit entries
        // two per geometry (primary ray, shadow ray): the triangle and the plane of instance 0, then
        // the triangles of instances 1 and 2. False (after printing why) on failure.
        createRayTracingPipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, folder: string): boolean {
            const desc = Nri_CreateRayTracingPipelineDesc();
            Nri_RayTracingPipelineDescAddGroup(desc, Nri_RayTracingPipelineDescAddShader(desc, NriStage.RayGen, "rayGen"), -1, -1);
            Nri_RayTracingPipelineDescAddGroup(desc, Nri_RayTracingPipelineDescAddShader(desc, NriStage.Miss, "miss"), -1, -1);
            Nri_RayTracingPipelineDescAddGroup(desc, Nri_RayTracingPipelineDescAddShader(desc, NriStage.Miss, "shadowMiss"), -1, -1);
            Nri_RayTracingPipelineDescAddGroup(desc, Nri_RayTracingPipelineDescAddShader(desc, NriStage.ClosestHit, "triangleChs"), -1, -1);
            Nri_RayTracingPipelineDescAddGroup(desc, Nri_RayTracingPipelineDescAddShader(desc, NriStage.ClosestHit, "planeChs"), -1, -1);
            Nri_RayTracingPipelineDescAddGroup(desc, Nri_RayTracingPipelineDescAddShader(desc, NriStage.ClosestHit, "shadowChs"), -1, -1);
            const pipeline = Nri_CreateRayTracingPipelineFromDesc(device, layout, `shaders/dxr_refit/${folder}/dxr_refit.bin`, desc,
                PAYLOAD_SIZE, ATTRIBUTE_SIZE, MAX_RECURSION_DEPTH);
            Nri_DestroyRayTracingPipelineDesc(desc);
            this.pipeline = pipeline;
            if (!pipeline) {
                console.log("Cannot initialize the ray tracing pipeline");
                return false;
            }

            const missGroups: int[] = [MISS_GROUP, SHADOW_MISS_GROUP];
            const hitGroups: int[] = [
                TRIANGLE_HIT_GROUP, SHADOW_HIT_GROUP,
                PLANE_HIT_GROUP, SHADOW_HIT_GROUP,
                TRIANGLE_HIT_GROUP, SHADOW_HIT_GROUP,
                TRIANGLE_HIT_GROUP, SHADOW_HIT_GROUP,
            ];
            this.shaderTable = Nri_CreateShaderTableFromGroups(device, this.queue, pipeline, RAYGEN_GROUP, Ref(missGroups[0]), missGroups.length,
                Ref(hitGroups[0]), hitGroups.length);
            if (!this.shaderTable) {
                console.log("Cannot create the shader table");
                return false;
            }
            return true;
        }

        // The tutorial's createAccelerationStructures: one BLAS of the triangle and the plane, one of
        // the triangle alone (the tutorial's geometries have no index buffers; here they index their
        // vertices in order); the refittable TLAS (built with AllowUpdate), its instances written to a
        // buffer per frame in flight. False (after printing why) on failure.
        createAccelerationStructures(device: NriDeviceHandle, queuedFrameNum: int): boolean {
            const triangleVertexCount = TRIANGLE_VERTICES.length / 3;
            const planeVertexCount = PLANE_VERTICES.length / 3;
            const triangleIndices: int[] = [];
            for (let i = 0; i < triangleVertexCount; i++) {
                triangleIndices.push(i);
            }
            const planeIndices: int[] = [];
            for (let i = 0; i < planeVertexCount; i++) {
                planeIndices.push(i);
            }
            for (let b = 0; b < 2; b++) {
                const desc = Nri_CreateBlasDesc();
                Nri_BlasDescAddTriangles(desc, Ref(TRIANGLE_VERTICES[0]), triangleVertexCount, Ref(triangleIndices[0]), triangleVertexCount);
                if (b == 0) {
                    Nri_BlasDescAddTriangles(desc, Ref(PLANE_VERTICES[0]), planeVertexCount, Ref(planeIndices[0]), planeVertexCount);
                }
                const blas = Nri_BuildBlasFromDesc(device, this.queue, desc, NriAccelerationStructureFlags.None);
                Nri_DestroyBlasDesc(desc);
                if (!blas) {
                    console.log("Cannot build the bottom level acceleration structures");
                    return false;
                }
                this.blases.push(blas);
            }

            const topLevelAS = Nri_CreateTopLevelAS(device, INSTANCE_X.length, NriAccelerationStructureFlags.AllowUpdate, queuedFrameNum);
            this.topLevelAS = topLevelAS;
            if (!topLevelAS) {
                console.log("Cannot create the top level acceleration structure");
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

        // The tutorial's buildTopLevelAS: instance 0 (the triangle and the plane) unmoved, instances 1
        // and 2 (the triangle) rotated about y by `rotation`, then moved to x = -2 and 2;
        // translate(x) * eulerAngleY(rotation) in rows. The instance ID picks the instance's colors in
        // the triangle's closest hit shader.
        addInstances(topLevelAS: NriTopLevelASHandle) {
            Nri_TopLevelASClearInstances(topLevelAS);
            const c = Math.cos(this.rotation);
            const s = Math.sin(this.rotation);
            for (let i = 0; i < INSTANCE_X.length; i++) {
                const rotated = i > 0;
                for (let j = 0; j < 12; j++) {
                    this.transform[j] = 0.0;
                }
                this.transform[0] = rotated ? c : 1.0;
                this.transform[2] = rotated ? s : 0.0;
                this.transform[3] = INSTANCE_X[i];
                this.transform[5] = 1.0;
                this.transform[8] = rotated ? -s : 0.0;
                this.transform[10] = rotated ? c : 1.0;
                Nri_TopLevelASAddInstance(topLevelAS, this.blases[rotated ? 1 : 0], Ref(this.transform[0]), i, 0xFF, INSTANCE_HIT_GROUPS[i], 0);
            }
        }

        // The tutorial's onFrameRender: refit the TLAS (built on the first frame), then step the
        // rotation; the rays into the output, which then goes to the copy.
        recordRays(commandBuffer: NriCommandBufferHandle, frameIndex: int) {
            const layout = this.layout;
            const pipeline = this.pipeline;
            const shaderTable = this.shaderTable;
            const descriptorPool = this.descriptorPool;
            const set = this.set;
            const output = this.output;
            const topLevelAS = this.topLevelAS;
            if (!layout || !pipeline || !shaderTable || !descriptorPool || !set || !output || !topLevelAS) {
                return;
            }
            // Donut's test mode animates by float(1/60) a frame; -benchmark by a fixed step.
            const elapsedSeconds = this.test ? Math.fround(1.0 / 60.0) : Nri_GetFrameTime(this.sample);
            const rotationStep = this.benchmark ? ROTATION_STEP : ROTATION_STEP * STEPS_PER_SECOND * elapsedSeconds;
            this.addInstances(topLevelAS);
            Nri_CmdBuildTopLevelAS(commandBuffer, topLevelAS, frameIndex % this.queuedFrames.length, this.rebuild ? 0 : 1);
            this.rotation = Math.fround(this.rotation + Math.fround(rotationStep));

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

        // The output copied into the frame without conversion, as the tutorial's CopyResource.
        recordCopy(commandBuffer: NriCommandBufferHandle, texture: NriTextureHandle) {
            const output = this.output;
            if (output) {
                Nri_CmdCopyTexture(commandBuffer, texture, output);
            }
        }

        renderFrame(frameIndex: int) {
            const queuedFrame = this.queuedFrames[frameIndex % this.queuedFrames.length];

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: the refit and the rays, then their output copied into the frame.
                Nri_BeginCommandBuffer(commandBuffer);
                this.recordRays(commandBuffer, frameIndex);
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
                this.destroyDescriptor(this.colorBufferView);
                this.destroyDescriptor(this.topLevelASView);
                const output = this.output;
                if (output) {
                    Nri_DestroyTexture(output);
                }
                const colorBuffer = this.colorBuffer;
                if (colorBuffer) {
                    Nri_DestroyBuffer(colorBuffer);
                }
                const topLevelAS = this.topLevelAS;
                if (topLevelAS) {
                    Nri_DestroyTopLevelAS(topLevelAS);
                }
                for (const blas of this.blases) {
                    Nri_DestroyAccelerationStructure(blas);
                }
                const shaderTable = this.shaderTable;
                if (shaderTable) {
                    Nri_DestroyShaderTable(shaderTable);
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    Nri_DestroyBuffer(readbackBuffer);
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
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const dxrRefit = new DxrRefit(sample);
        // -benchmark: 0.005 radians a frame; -rebuild: the TLAS built anew every frame.
        Nri_AddExampleOption(sample, "-benchmark");
        Nri_AddExampleOption(sample, "-rebuild");
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-benchmark") {
                dxrRefit.benchmark = true;
            } else if (arg == "-rebuild") {
                dxrRefit.rebuild = true;
            }
        }
        return dxrRefit.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return DxrRefitNri.main(argc, argv);
}

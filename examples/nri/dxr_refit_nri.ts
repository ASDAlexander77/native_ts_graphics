/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { Nri, NriAccelerationStructure, NriBlasDesc, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriPipeline, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriRayTracingPipelineDesc, NriSample, NriShaderTable, NriTexture, NriTopLevelAS } from "../../core/nri";

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

    // The pipeline's shader groups (NriRayTracingPipelineDesc.addGroup's order).
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
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private layout: NriPipelineLayout | null = null;
        private pipeline: NriPipeline | null = null;
        private shaderTable: NriShaderTable | null = null;
        // The triangle and the plane, the triangle alone.
        private blases: NriAccelerationStructure[] = [];
        private topLevelAS: NriTopLevelAS | null = null;
        private topLevelASView: NriDescriptor | null = null;
        private colorBuffer: NriBuffer | null = null;
        private colorBufferView: NriDescriptor | null = null;
        private output: NriTexture | null = null;
        private outputStorage: NriDescriptor | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private set: NriDescriptorSet | null = null;
        // The output was copied from (after the first frame).
        private outputCopied: boolean = false;
        // A row-major 3x4 instance transform.
        private transform: f32[] = [];
        private rotation: number = 0.0;
        // The swap chain's size (the window's when it was made) and its textures' format.
        private width: int = 0;
        private height: int = 0;
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        // -benchmark: 0.005 radians a frame, as the tutorial (for comparisons); -rebuild: build the
        // TLAS anew every frame instead of refitting it.
        benchmark: boolean = false;
        rebuild: boolean = false;

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
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
            this.sample.setInitializeCallback(initialize);
            this.sample.setLatencySleepCallback(latencySleep);
            this.sample.setRenderFrameCallback(renderFrame);
            this.sample.setWindowSize(WINDOW_WIDTH, WINDOW_HEIGHT);

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

            // Swap chain: copied into, in its own (UNORM) format: the shader writes sRGB-encoded
            // values, as the tutorial's CopyResource into its sRGB back buffer.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, false);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;

            // Queued frames
            this.frames.init(device, this.queue, queuedFrameNum);

            // Ray tracing pipelines: D3D12 or Vulkan (the Donut example's shaders have no DXBC).
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "No D3D11 shaders (ray tracing needs D3D12 or Vulkan)";
                return 0;
            }
            if (device.isFeatureSupported(NriFeature.RayTracing) == 0) {
                this.unsupportedReason = "The graphics device does not support Ray Tracing Pipelines";
                return 0;
            }

            // The layout: the scene (t0), the output (u0) and the instances' colors (b0), for every
            // ray tracing stage (the plane's closest hit shader traces shadow rays).
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.AccelerationStructure, NriStage.RayTracing, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.StorageTexture, NriStage.RayTracing, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.RayTracing, NriRangeFlags.None);
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
            if (!this.createAccelerationStructures(device, queuedFrameNum)) {
                return 0;
            }

            // The instances' colors, written once.
            const colorBuffer = device.createHostBuffer(COLOR_BUFFER_SIZE, NriBufferUsage.ConstantBuffer);
            this.colorBuffer = colorBuffer;
            if (!colorBuffer) {
                console.log("Cannot create the color buffer");
                return 0;
            }
            colorBuffer.write(0, Ref(INSTANCE_COLORS[0]), INSTANCE_COLORS.length * 4);
            const colorBufferView = colorBuffer.createConstantView(0, COLOR_BUFFER_SIZE);
            this.colorBufferView = colorBufferView;

            // The output the ray generation shader writes, in the back buffer's format, for the copy.
            const outputCreated = this.createOutput(device);
            const descriptorPool = device.createDescriptorPoolWithAccelerationStructures(1, 0, 1, 0, 1, 0, 1);
            this.descriptorPool = descriptorPool;
            const topLevelASView = this.topLevelASView;
            if (!outputCreated || !descriptorPool || !topLevelASView || !colorBufferView) {
                console.log("Cannot create the output");
                return 0;
            }
            const set = descriptorPool.allocateDescriptorSet(layout, 0, 0);
            this.set = set;
            if (!set) {
                console.log("Cannot create the descriptor set");
                return 0;
            }
            set.updateDescriptor(0, 0, topLevelASView);
            this.updateOutputDescriptor();
            set.updateDescriptor(2, 0, colorBufferView);

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

        updateOutputDescriptor() {
            const set = this.set;
            const outputStorage = this.outputStorage;
            if (set) {
                if (outputStorage) {
                    set.updateDescriptor(1, 0, outputStorage);
                }
            }
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain and the output made again at
        // its size, once the GPU is done with the old ones.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (!this.swapChain.resized()) {
                return;
            }
            device.waitIdle();
            this.destroyOutput();
            this.swapChain.recreate();
            this.sizeToSwapChain();
            this.createOutput(device);
            this.updateOutputDescriptor();
        }

        // The tutorial's createRtPipelineState and createShaderTable: the ray generation shader, the
        // primary and shadow miss shaders, the triangle, plane and shadow hit groups; the hit entries
        // two per geometry (primary ray, shadow ray): the triangle and the plane of instance 0, then
        // the triangles of instances 1 and 2. False (after printing why) on failure.
        createRayTracingPipeline(device: NriDevice, layout: NriPipelineLayout, folder: string): boolean {
            const desc = NriRayTracingPipelineDesc.create();
            desc.addGroup(desc.addShader(NriStage.RayGen, "rayGen"), -1, -1);
            desc.addGroup(desc.addShader(NriStage.Miss, "miss"), -1, -1);
            desc.addGroup(desc.addShader(NriStage.Miss, "shadowMiss"), -1, -1);
            desc.addGroup(desc.addShader(NriStage.ClosestHit, "triangleChs"), -1, -1);
            desc.addGroup(desc.addShader(NriStage.ClosestHit, "planeChs"), -1, -1);
            desc.addGroup(desc.addShader(NriStage.ClosestHit, "shadowChs"), -1, -1);
            const pipeline = device.createRayTracingPipelineFromDesc(layout, `shaders/dxr_refit/${folder}/dxr_refit.bin`, desc,
                PAYLOAD_SIZE, ATTRIBUTE_SIZE, MAX_RECURSION_DEPTH);
            desc.destroy();
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
            this.shaderTable = device.createShaderTableFromGroups(this.queue, pipeline, RAYGEN_GROUP, Ref(missGroups[0]), missGroups.length,
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
        createAccelerationStructures(device: NriDevice, queuedFrameNum: int): boolean {
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
                const desc = NriBlasDesc.create();
                desc.addTriangles(Ref(TRIANGLE_VERTICES[0]), triangleVertexCount, Ref(triangleIndices[0]), triangleVertexCount);
                if (b == 0) {
                    desc.addTriangles(Ref(PLANE_VERTICES[0]), planeVertexCount, Ref(planeIndices[0]), planeVertexCount);
                }
                const blas = device.buildBlasFromDesc(this.queue, desc, NriAccelerationStructureFlags.None);
                desc.destroy();
                if (!blas) {
                    console.log("Cannot build the bottom level acceleration structures");
                    return false;
                }
                this.blases.push(blas);
            }

            const topLevelAS = device.createTopLevelAS(INSTANCE_X.length, NriAccelerationStructureFlags.AllowUpdate, queuedFrameNum);
            this.topLevelAS = topLevelAS;
            if (!topLevelAS) {
                console.log("Cannot create the top level acceleration structure");
                return false;
            }
            this.topLevelASView = topLevelAS.getTopLevelAccelerationStructure().createDescriptor();
            return true;
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The tutorial's buildTopLevelAS: instance 0 (the triangle and the plane) unmoved, instances 1
        // and 2 (the triangle) rotated about y by `rotation`, then moved to x = -2 and 2;
        // translate(x) * eulerAngleY(rotation) in rows. The instance ID picks the instance's colors in
        // the triangle's closest hit shader.
        addInstances(topLevelAS: NriTopLevelAS) {
            topLevelAS.clearInstances();
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
                topLevelAS.addInstance(this.blases[rotated ? 1 : 0], Ref(this.transform[0]), i, 0xFF, INSTANCE_HIT_GROUPS[i], 0);
            }
        }

        // The tutorial's onFrameRender: refit the TLAS (built on the first frame), then step the
        // rotation; the rays into the output, which then goes to the copy.
        recordRays(commandBuffer: NriCommandBuffer, frameIndex: int) {
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
            const elapsedSeconds = this.test ? Math.fround(1.0 / 60.0) : this.sample.getFrameTime();
            const rotationStep = this.benchmark ? ROTATION_STEP : ROTATION_STEP * STEPS_PER_SECOND * elapsedSeconds;
            this.addInstances(topLevelAS);
            commandBuffer.buildTopLevelAS(topLevelAS, frameIndex % this.frames.size(), this.rebuild ? 0 : 1);
            this.rotation = Math.fround(this.rotation + Math.fround(rotationStep));

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

        // The output copied into the frame without conversion, as the tutorial's CopyResource.
        recordCopy(commandBuffer: NriCommandBuffer, texture: NriTexture) {
            const output = this.output;
            if (output) {
                commandBuffer.copyTexture(texture, output);
            }
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: the refit and the rays, then their output copied into the frame.
                commandBuffer.begin();
                this.recordRays(commandBuffer, frameIndex);
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
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                this.destroyOutput();
                this.destroyDescriptor(this.colorBufferView);
                this.destroyDescriptor(this.topLevelASView);
                const colorBuffer = this.colorBuffer;
                if (colorBuffer) {
                    colorBuffer.destroy();
                }
                const topLevelAS = this.topLevelAS;
                if (topLevelAS) {
                    topLevelAS.destroy();
                }
                for (const blas of this.blases) {
                    blas.destroy();
                }
                const shaderTable = this.shaderTable;
                if (shaderTable) {
                    shaderTable.destroy();
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    readbackBuffer.destroy();
                }
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
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const dxrRefit = new DxrRefit(sample);
        // -benchmark: 0.005 radians a frame; -rebuild: the TLAS built anew every frame.
        sample.addExampleOption("-benchmark");
        sample.addExampleOption("-rebuild");
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
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

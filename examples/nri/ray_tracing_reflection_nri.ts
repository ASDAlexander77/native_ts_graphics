/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { radians, perspective, inverseGaussJordan } from "../../core/matrix";
import { LookAtCamera } from "../../core/vulkan_samples_camera";
import { Nri, NriAccelerationStructure, NriBlasDesc, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriPipeline, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriRayTracingPipelineDesc, NriSample, NriShaderTable, NriTexture, NriTopLevelAS } from "../../core/nri";

namespace RayTracingReflectionNri {
    // ray_tracing_reflection, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (ray_tracing_reflection.hlsl's library), through the NRI calls
    // core/nri/nri_interop.d.ts binds. This example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no ray tracing, or no shaders for
    // the graphics API (D3D11).
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Ray Tracing Reflection";

    // The sample's camera: look-at type, not turned, at (0, 0, -2.5) (vkb::Camera's position, the
    // view's translation).
    const CAMERA_POSITION = [0.0, 0.0, -2.5];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 0.1;
    const Z_FAR = 512.0;

    // struct hitPayload { float3 radiance, attenuation; int done; float3 rayOrigin, rayDir; }, and the
    // triangles' float2 barycentrics.
    const PAYLOAD_SIZE = 13 * 4;
    const ATTRIBUTE_SIZE = 8;
    // The closest hit shader traces shadow rays.
    const MAX_RECURSION_DEPTH = 2;

    // struct UniformData { float4x4 view_inverse, proj_inverse; }, in a 256-byte part of the buffer a
    // frame in flight (D3D12 constant buffer views are 256-byte multiples).
    const UBO_VIEW_INVERSE = 0;
    const UBO_PROJ_INVERSE = 16;
    const UBO_FLOATS = 32;
    const UBO_STRIDE = 256;

    // ObjVertex: float3 pos, float3 nrm. ObjMaterial: float3 diffuse, float3 specular, float
    // shininess.
    const VERTEX_FLOATS = 6;
    const MATERIAL_FLOATS = 7;

    // nri::TopLevelInstanceBits::TRIANGLE_CULL_DISABLE (nvrhi::rt::InstanceFlags::TriangleCullDisable's
    // value too).
    const INSTANCE_FLAGS_CULL_DISABLE = 1;

    // The pipeline's shader groups (NriRayTracingPipelineDesc.addGroup's order).
    const RAYGEN_GROUP = 0;
    const MISS_GROUP = 1;
    const SHADOW_MISS_GROUP = 2;
    const HIT_GROUP = 3;

    // The sample's ObjPlane: a 2 x 2 square facing +y.
    const PLANE_VERTICES = [
        +1.0, 0.0, +1.0, 0.0, 1.0, 0.0,
        -1.0, 0.0, +1.0, 0.0, 1.0, 0.0,
        +1.0, 0.0, -1.0, 0.0, 1.0, 0.0,
        -1.0, 0.0, -1.0, 0.0, 1.0, 0.0,
    ];
    const PLANE_INDICES = [0, 1, 2, 1, 2, 3];
    const PLANE_MAT_INDEX = [0, 0];

    // Its ObjCube: a unit cube, each face's 4 vertices with its normal.
    const CUBE_VERTICES = [
        +0.5, +0.5, +0.5, +0.0, +1.0, +0.0,        // Top
        -0.5, +0.5, +0.5, +0.0, +1.0, +0.0,
        +0.5, +0.5, -0.5, +0.0, +1.0, +0.0,
        -0.5, +0.5, -0.5, +0.0, +1.0, +0.0,
        +0.5, -0.5, +0.5, +0.0, -1.0, +0.0,        // Bottom
        -0.5, -0.5, +0.5, +0.0, -1.0, +0.0,
        +0.5, -0.5, -0.5, +0.0, -1.0, +0.0,
        -0.5, -0.5, -0.5, +0.0, -1.0, +0.0,
        +0.5, +0.5, +0.5, +1.0, +0.0, +0.0,        // Right
        +0.5, +0.5, -0.5, +1.0, +0.0, +0.0,
        +0.5, -0.5, -0.5, +1.0, +0.0, +0.0,
        +0.5, -0.5, +0.5, +1.0, +0.0, +0.0,
        -0.5, +0.5, +0.5, -1.0, +0.0, +0.0,        // left
        -0.5, +0.5, -0.5, -1.0, +0.0, +0.0,
        -0.5, -0.5, -0.5, -1.0, +0.0, +0.0,
        -0.5, -0.5, +0.5, -1.0, +0.0, +0.0,
        -0.5, +0.5, +0.5, +0.0, +0.0, +1.0,        // front
        +0.5, +0.5, +0.5, +0.0, +0.0, +1.0,
        +0.5, -0.5, +0.5, +0.0, +0.0, +1.0,
        -0.5, -0.5, +0.5, +0.0, +0.0, +1.0,
        -0.5, +0.5, -0.5, +0.0, +0.0, -1.0,        // back
        +0.5, +0.5, -0.5, +0.0, +0.0, -1.0,
        +0.5, -0.5, -0.5, +0.0, +0.0, -1.0,
        -0.5, -0.5, -0.5, +0.0, +0.0, -1.0,
    ];
    const CUBE_INDICES = [
        0, 1, 2, 1, 2, 3,       /*top*/
        4, 5, 6, 5, 6, 7,       /*bottom*/
        8, 9, 10, 8, 10, 11,    /*right*/
        12, 13, 14, 12, 14, 15, /*left*/
        16, 17, 18, 16, 18, 19, /*front*/
        20, 21, 22, 20, 22, 23, /*back*/
    ];
    const CUBE_MAT_INDEX = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5];

    // The sample's materials (diffuse, specular, shininess).
    const MAT_RED = [1.0, 0.0, 0.0, 1.0, 1.0, 1.0, 0.0];
    const MAT_GREEN = [0.0, 1.0, 0.0, 1.0, 1.0, 1.0, 0.0];
    const MAT_BLUE = [0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0];
    const MAT_YELLOW = [1.0, 1.0, 0.0, 1.0, 1.0, 1.0, 0.0];
    const MAT_CYAN = [0.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.0];
    const MAT_MAGENTA = [1.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0];
    // Slightly reflective
    const MAT_GREY = [0.7, 0.7, 0.7, 0.9, 0.9, 0.9, 0.1];
    // Mirror Slightly blue
    const MAT_MIRROR = [0.3, 0.9, 1.0, 0.9, 0.9, 0.9, 0.9];

    // The models appended to one array of each (create_model): each model's offsets in them (its scene
    // description: first vertex, index, material index, material), vertices, indices, material indices
    // (clamped to its materials), then its materials.
    class ModelArrays {
        vertices: f32[] = [];
        indices: int[] = [];
        matIndices: int[] = [];
        materials: f32[] = [];
        objDesc: int[] = [];
        // Each model's vertex and index counts.
        vertexCounts: int[] = [];
        indexCounts: int[] = [];

        // A model with materialCount materials (added next, with addMaterial).
        addModel(vertexList: number[], indexList: int[], matIndexList: int[], materialCount: int) {
            this.vertexCounts.push(vertexList.length / VERTEX_FLOATS);
            this.indexCounts.push(indexList.length);
            this.objDesc.push(this.vertices.length / VERTEX_FLOATS);
            this.objDesc.push(this.indices.length);
            this.objDesc.push(this.matIndices.length);
            this.objDesc.push(this.materials.length / MATERIAL_FLOATS);
            for (const coordinate of vertexList) {
                this.vertices.push(coordinate);
            }
            for (const index of indexList) {
                this.indices.push(index);
            }
            const maxIndex = materialCount - 1;
            for (const matIndex of matIndexList) {
                this.matIndices.push(Math.min(maxIndex, matIndex));
            }
        }

        addMaterial(material: number[]) {
            for (let i = 0; i < MATERIAL_FLOATS; i++) {
                this.materials.push(material[i]);
            }
        }
    }

    // glm::scale(glm::translate(mat4(1), t), s): columns scaled, translation t.
    function scaled(tx: number, ty: number, tz: number, sx: number, sy: number, sz: number) {
        return [sx, 0.0, 0.0, 0.0, 0.0, sy, 0.0, 0.0, 0.0, 0.0, sz, 0.0, tx, ty, tz, 1.0];
    }

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // A frame in flight's own data: its uniforms' set.
    class QueuedFrame {
        constructor(public uniformView: NriDescriptor | null, public set: NriDescriptorSet | null) {
        }
    }

    // core/test_check.ts' share: count is between `min` and `max` hundredths of `total` pixels; what
    // names them in the failure. Logs the share.
    function share(count: int, total: int, min: number, max: number, what: string): string {
        const percent = 100.0 * count / total;
        console.log(`${what}: ${percent}% (${count} of ${total} pixels)`);
        if (percent < min || percent > max) {
            return `${what}: ${percent}% of the pixels, not ${min}% to ${max}%`;
        }
        return "";
    }

    // -test: checks the last frame, read back, as the Donut example does. The top corners are the gray
    // background; the cubes and their reflections color about a quarter of the frame (channels at
    // least 61 apart), blue about 1.5%.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const total = width * height;
        if ((pixels[0] & 0xFFFFFF) != 0x4C4C4C || (pixels[width - 1] & 0xFFFFFF) != 0x4C4C4C) {
            return "the top corners aren't the gray background";
        }
        let colored = 0;
        let blue = 0;
        for (let i = 0; i < total; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            const high = Math.max(r, Math.max(g, b));
            const low = Math.min(r, Math.min(g, b));
            if (high - low >= 61) {
                colored++;
            }
            if (r <= 89 && g <= 119 && b >= 121) {
                blue++;
            }
        }
        const coloredShare = share(colored, total, 15.0, 35.0, "Colored");
        if (coloredShare != "") {
            return coloredShare;
        }
        return share(blue, total, 0.8, 3.0, "Blue");
    }

    // Port of Vulkan-Samples' ray_tracing_reflection, as examples/ray_tracing_reflection.ts ports it, to
    // NRI: two cubes with a color per face over a slightly reflective floor, between two mirrors facing
    // each other, ray traced with a ray tracing pipeline. Each ray bounces off reflective surfaces until
    // little of it is left (up to 64 times); each hit is lit by a fixed light, with a shadow ray (a
    // second miss shader). The scene: three models (the colored cube, the plane, the mirror cube), five
    // instances. The rays write the back buffer's format, copied into it. The left mouse button turns
    // the camera, the right one zooms, the middle one pans.
    class RayTracingReflection {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private layout: NriPipelineLayout | null = null;
        private pipeline: NriPipeline | null = null;
        private shaderTable: NriShaderTable | null = null;
        private blases: NriAccelerationStructure[] = [];
        private topLevelAS: NriTopLevelAS | null = null;
        private topLevelASView: NriDescriptor | null = null;
        // The scene description, vertices, indices, material indices and materials (t1 to t5).
        private buffers: NriBuffer[] = [];
        private bufferViews: NriDescriptor[] = [];
        private uniformBuffer: NriBuffer | null = null;
        private output: NriTexture | null = null;
        private outputStorage: NriDescriptor | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        // The output was copied from (after the first frame).
        private outputCopied: boolean = false;
        // The swap chain's size: the window's when it was (re)created.
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format.
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        private camera: LookAtCamera = new LookAtCamera(CAMERA_POSITION, [0.0, 0.0, 0.0]);
        // The mouse, as the camera sees it: its position (summed from its moves) and buttons.
        private mouseX: number = 0.0;
        private mouseY: number = 0.0;
        private buttons: boolean[] = [false, false, false];

        // Upload buffers.
        private ubo: f32[] = [];
        private transform: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
            }
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

            // Swap chain: copied into, in its own (UNORM) format, as the sample's vkCmdCopyImage: the
            // UNORM values become the back buffer's encoded ones.
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

            // The layout: the camera (b0), the scene (t0), its buffers (t1 to t5) and the output (u0),
            // for every ray tracing stage (the closest hit shader traces shadow rays).
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.RayTracing, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.AccelerationStructure, NriStage.RayTracing, NriRangeFlags.None);
            layoutDesc.addRange(0, 1, 5, NriDescriptorType.StructuredBuffer, NriStage.RayTracing, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.StorageTexture, NriStage.RayTracing, NriRangeFlags.None);
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
            if (!this.createModels(device)) {
                return 0;
            }
            if (!this.createScene(device)) {
                return 0;
            }

            // The camera's uniforms, written every frame into the frame's part.
            const uniformBuffer = device.createHostBuffer(UBO_STRIDE * queuedFrameNum, NriBufferUsage.ConstantBuffer);
            this.uniformBuffer = uniformBuffer;

            // The storage image the ray generation shader writes, in the back buffer's format, for the
            // copy.
            const created = this.createOutput(device);
            const descriptorPool = device.createDescriptorPoolWithAccelerationStructures(queuedFrameNum, 0, queuedFrameNum, 0,
                queuedFrameNum, 5 * queuedFrameNum, queuedFrameNum);
            this.descriptorPool = descriptorPool;
            const topLevelASView = this.topLevelASView;
            if (!uniformBuffer || !created || !descriptorPool || !topLevelASView) {
                console.log("Cannot create the output");
                return 0;
            }
            const outputStorage = this.outputStorage;
            if (!outputStorage) {
                console.log("Cannot create the output's view");
                return 0;
            }

            // A set per frame in flight: its own part of the uniforms.
            for (let i = 0; i < queuedFrameNum; i++) {
                const queuedFrame = this.queuedFrames[i];
                const uniformView = uniformBuffer.createConstantView(i * UBO_STRIDE, UBO_STRIDE);
                queuedFrame.uniformView = uniformView;
                const set = descriptorPool.allocateDescriptorSet(layout, 0, 0);
                queuedFrame.set = set;
                if (!set || !uniformView) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                set.updateDescriptor(0, 0, uniformView);
                set.updateDescriptor(1, 0, topLevelASView);
                for (let b = 0; b < this.bufferViews.length; b++) {
                    set.updateDescriptor(2, b, this.bufferViews[b]);
                }
                set.updateDescriptor(3, 0, outputStorage);
            }

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The sample's create_ray_tracing_pipeline and create_shader_binding_tables: ray generation, the
        // miss shaders (primary rays, then shadow rays) and one hit group. False (after printing why)
        // on failure.
        createRayTracingPipeline(device: NriDevice, layout: NriPipelineLayout, folder: string): boolean {
            const desc = NriRayTracingPipelineDesc.create();
            desc.addGroup(desc.addShader(NriStage.RayGen, "raygen"), -1, -1);
            desc.addGroup(desc.addShader(NriStage.Miss, "miss"), -1, -1);
            desc.addGroup(desc.addShader(NriStage.Miss, "missShadow"), -1, -1);
            desc.addGroup(desc.addShader(NriStage.ClosestHit, "closesthit"), -1, -1);
            const pipeline = device.createRayTracingPipelineFromDesc(layout,
                `shaders/ray_tracing_reflection/${folder}/ray_tracing_reflection.bin`, desc, PAYLOAD_SIZE, ATTRIBUTE_SIZE,
                MAX_RECURSION_DEPTH);
            desc.destroy();
            this.pipeline = pipeline;
            if (!pipeline) {
                console.log("Cannot initialize the ray tracing pipeline");
                return false;
            }

            const missGroups: int[] = [MISS_GROUP, SHADOW_MISS_GROUP];
            const hitGroups: int[] = [HIT_GROUP];
            this.shaderTable = device.createShaderTableFromGroups(this.queue, pipeline, RAYGEN_GROUP, Ref(missGroups[0]), missGroups.length,
                Ref(hitGroups[0]), hitGroups.length);
            if (!this.shaderTable) {
                console.log("Cannot create the shader table");
                return false;
            }
            return true;
        }

        // The sample's create_model for each model and create_bottom_level_acceleration_structure: its
        // vertices, indices, material indices (clamped to its materials) and materials, appended to one
        // buffer of each, and a BLAS of its triangles (its positions and indices given apart, as the
        // BLAS desc takes them). False (after printing why) on failure.
        createModels(device: NriDevice): boolean {
            // The cube with its 6 color faces, the plane (slightly reflective), the mirror cube.
            const arrays = new ModelArrays();
            arrays.addModel(CUBE_VERTICES, CUBE_INDICES, CUBE_MAT_INDEX, 6);
            arrays.addMaterial(MAT_RED);
            arrays.addMaterial(MAT_GREEN);
            arrays.addMaterial(MAT_BLUE);
            arrays.addMaterial(MAT_YELLOW);
            arrays.addMaterial(MAT_CYAN);
            arrays.addMaterial(MAT_MAGENTA);
            arrays.addModel(PLANE_VERTICES, PLANE_INDICES, PLANE_MAT_INDEX, 1);
            arrays.addMaterial(MAT_GREY);
            arrays.addModel(CUBE_VERTICES, CUBE_INDICES, CUBE_MAT_INDEX, 1);
            arrays.addMaterial(MAT_MIRROR);
            const vertices = arrays.vertices;
            const indices = arrays.indices;
            const matIndices = arrays.matIndices;
            const materials = arrays.materials;
            const objDesc = arrays.objDesc;

            // The shaders' buffers, in register order (t1 to t5).
            const objDescBuffer = device.createUploadedStructuredBufferFromInts(this.queue, Ref(objDesc[0]), objDesc.length * 4, 16);
            const vertexBuffer = device.createUploadedStructuredBuffer(this.queue, Ref(vertices[0]), vertices.length * 4, 4);
            const indexBuffer = device.createUploadedStructuredBufferFromInts(this.queue, Ref(indices[0]), indices.length * 4, 4);
            const matIndexBuffer = device.createUploadedStructuredBufferFromInts(this.queue, Ref(matIndices[0]), matIndices.length * 4, 4);
            const materialBuffer = device.createUploadedStructuredBuffer(this.queue, Ref(materials[0]), materials.length * 4, 4);
            if (!objDescBuffer || !vertexBuffer || !indexBuffer || !matIndexBuffer || !materialBuffer) {
                console.log("Cannot create the scene's buffers");
                return false;
            }
            this.buffers = [objDescBuffer, vertexBuffer, indexBuffer, matIndexBuffer, materialBuffer];
            for (const buffer of this.buffers) {
                const view = buffer.createStructuredView(0);
                if (!view) {
                    console.log("Cannot create the scene's buffer views");
                    return false;
                }
                this.bufferViews.push(view);
            }

            for (let o = 0; o < arrays.vertexCounts.length; o++) {
                // The model's vertices and indices, at its offsets in the appended arrays.
                const firstVertex = objDesc[o * 4];
                const firstIndex = objDesc[o * 4 + 1];
                const vertexCount = arrays.vertexCounts[o];
                const positions: f32[] = [];
                for (let v = 0; v < vertexCount; v++) {
                    for (let c = 0; c < 3; c++) {
                        positions.push(vertices[(firstVertex + v) * VERTEX_FLOATS + c]);
                    }
                }
                const indexList: int[] = [];
                for (let i = 0; i < arrays.indexCounts[o]; i++) {
                    indexList.push(indices[firstIndex + i]);
                }
                const desc = NriBlasDesc.create();
                desc.addTriangles(Ref(positions[0]), vertexCount, Ref(indexList[0]), indexList.length);
                const blas = device.buildBlasFromDesc(this.queue, desc, NriAccelerationStructureFlags.PreferFastTrace);
                desc.destroy();
                if (!blas) {
                    console.log("Cannot build the bottom level acceleration structures");
                    return false;
                }
                this.blases.push(blas);
            }
            return vertices.length > 0;
        }

        // The sample's create_blas_instance: the instance's transform, transposed to 3 rows of 4, its
        // custom index the model's (for its buffers).
        addInstance(topLevelAS: NriTopLevelAS, blasId: int, m: number[]) {
            for (let row = 0; row < 3; row++) {
                for (let column = 0; column < 4; column++) {
                    this.transform[row * 4 + column] = m[column * 4 + row];
                }
            }
            topLevelAS.addInstance(this.blases[blasId], Ref(this.transform[0]), blasId, 0xFF, 0, INSTANCE_FLAGS_CULL_DISABLE);
        }

        // The rest of the sample's create_scene: the mirrors behind and in front, the floor below, the
        // two cubes side by side; built once (nothing moves). False (after printing why) on failure.
        createScene(device: NriDevice): boolean {
            const topLevelAS = device.createTopLevelAS(5, NriAccelerationStructureFlags.PreferFastTrace, 1);
            this.topLevelAS = topLevelAS;
            if (!topLevelAS) {
                console.log("Cannot create the top level acceleration structure");
                return false;
            }
            this.addInstance(topLevelAS, 0, scaled(-1.0, 0.0, 0.0, 1.0, 1.0, 1.0));
            this.addInstance(topLevelAS, 0, scaled(1.0, 0.0, 0.0, 1.0, 1.0, 1.0));
            this.addInstance(topLevelAS, 1, scaled(0.0, -1.0, 0.0, 15.0, 15.0, 15.0));
            this.addInstance(topLevelAS, 2, scaled(0.0, 0.0, -7.0, 5.0, 5.0, 0.1));
            this.addInstance(topLevelAS, 2, scaled(0.0, 0.0, 7.0, 5.0, 5.0, 0.1));
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

        // The camera's mouse handling: the buttons' changes, then the move.
        handleMouse() {
            for (let button = 0; button < 3; button++) {
                const pressed = this.sample.isButtonPressed(button) != 0;
                if (pressed != this.buttons[button]) {
                    this.camera.mouseButton(<MouseButton>button, <Action>(pressed ? 1 : 0));
                    this.buttons[button] = pressed;
                }
            }
            this.mouseX += this.sample.getMouseDeltaX();
            this.mouseY += this.sample.getMouseDeltaY();
            this.camera.mouseMove(this.mouseX, this.mouseY);
        }

        // The sample's update_uniform_buffers: the inverses of its view and of its projection with the
        // Vulkan y flip (the ray generation shader's launch rows run down, as Vulkan's).
        updateUniformBuffers(width: int, height: int) {
            let projection = perspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
            projection[5] = -projection[5];
            const projInverse = inverseGaussJordan(projection);
            const viewInverse = inverseGaussJordan(this.camera.view());
            for (let i = 0; i < 16; i++) {
                this.ubo[UBO_VIEW_INVERSE + i] = viewInverse[i];
                this.ubo[UBO_PROJ_INVERSE + i] = projInverse[i];
            }
        }

        // The uniforms (into the frame's part), then the rays into the output, which then goes to the
        // copy.
        recordRays(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame, frameIndex: int) {
            const layout = this.layout;
            const pipeline = this.pipeline;
            const shaderTable = this.shaderTable;
            const descriptorPool = this.descriptorPool;
            const set = queuedFrame.set;
            const output = this.output;
            const uniformBuffer = this.uniformBuffer;
            if (!layout || !pipeline || !shaderTable || !descriptorPool || !set || !output || !uniformBuffer) {
                return;
            }
            this.updateUniformBuffers(this.width, this.height);
            uniformBuffer.write((frameIndex % this.queuedFrames.length) * UBO_STRIDE, Ref(this.ubo[0]), UBO_FLOATS * 4);

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

        // The output copied into the frame without conversion, as the sample's vkCmdCopyImage.
        recordCopy(commandBuffer: NriCommandBuffer, texture: NriTexture) {
            const output = this.output;
            if (output) {
                commandBuffer.copyTexture(texture, output);
            }
        }

        // The swap chain's size and formats (its views in the textures' format).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
        }

        // The storage image the ray generation shader writes, at the swap chain's size and in its format
        // (for the copy), and its view; false if the image can't be made. Once the sets exist, their
        // output slots point at the new view; it starts as made (the first frame's state).
        createOutput(device: NriDevice): boolean {
            const output = device.createStorageTexture(this.queue, this.width, this.height, this.swapChainFormat);
            this.output = output;
            if (!output) {
                return false;
            }
            const outputStorage = output.createStorageView(this.swapChainFormat);
            this.outputStorage = outputStorage;
            if (outputStorage) {
                for (const queuedFrame of this.queuedFrames) {
                    const set = queuedFrame.set;
                    if (set) {
                        set.updateDescriptor(3, 0, outputStorage);
                    }
                }
            }
            this.outputCopied = false;
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

        // The window was resized (NriSample.useResizableWindow): the swap chain and the ray traced output made again at its size, once the
        // GPU is done with the old ones.
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
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrame = this.queuedFrames[frameIndex % this.queuedFrames.length];
            this.handleMouse();

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
                    this.destroyDescriptor(queuedFrame.uniformView);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                this.destroyOutput();
                this.destroyDescriptor(this.topLevelASView);
                for (const view of this.bufferViews) {
                    view.destroy();
                }
                for (const buffer of this.buffers) {
                    buffer.destroy();
                }
                const uniformBuffer = this.uniformBuffer;
                if (uniformBuffer) {
                    uniformBuffer.destroy();
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
        return new RayTracingReflection(sample).run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return RayTracingReflectionNri.main(argc, argv);
}

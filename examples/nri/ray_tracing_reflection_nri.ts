/// <reference path="../../core/nri/nri_interop.d.ts" />
import { radians, perspective, inverseGaussJordan } from "../../core/matrix";
import { LookAtCamera } from "../../core/vulkan_samples_camera";

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

    // The pipeline's shader groups (Nri_RayTracingPipelineDescAddGroup's order).
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

    // glm::scale(glm::translate(mat4(1), t), s): columns scaled, translation t.
    function scaled(tx: number, ty: number, tz: number, sx: number, sy: number, sz: number) {
        return [sx, 0.0, 0.0, 0.0, 0.0, sy, 0.0, 0.0, 0.0, 0.0, sz, 0.0, tx, ty, tz, 1.0];
    }

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into, and its uniforms' set.
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public uniformView: NriDescriptorHandle | null, public set: NriDescriptorSetHandle | null) {
        }
    }

    // A swap chain texture and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
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
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private layout: NriPipelineLayoutHandle | null = null;
        private pipeline: NriPipelineHandle | null = null;
        private shaderTable: NriShaderTableHandle | null = null;
        private blases: NriAccelerationStructureHandle[] = [];
        private topLevelAS: NriTopLevelASHandle | null = null;
        private topLevelASView: NriDescriptorHandle | null = null;
        // The scene description, vertices, indices, material indices and materials (t1 to t5).
        private buffers: NriBufferHandle[] = [];
        private bufferViews: NriDescriptorHandle[] = [];
        private uniformBuffer: NriBufferHandle | null = null;
        private output: NriTextureHandle | null = null;
        private outputStorage: NriDescriptorHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
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
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
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

            // Swap chain: copied into, in its own (UNORM) format, as the sample's vkCmdCopyImage: the
            // UNORM values become the back buffer's encoded ones.
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.createSwapChain(device);
            const format = this.swapChainFormat;

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

            // The layout: the camera (b0), the scene (t0), its buffers (t1 to t5) and the output (u0),
            // for every ray tracing stage (the closest hit shader traces shadow rays).
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.RayTracing, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.AccelerationStructure, NriStage.RayTracing, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 1, 5, NriDescriptorType.StructuredBuffer, NriStage.RayTracing, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.StorageTexture, NriStage.RayTracing, NriRangeFlags.None);
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
            if (!this.createModels(device)) {
                return 0;
            }
            if (!this.createScene(device)) {
                return 0;
            }

            // The camera's uniforms, written every frame into the frame's part.
            const uniformBuffer = Nri_CreateHostBuffer(device, UBO_STRIDE * queuedFrameNum, NriBufferUsage.ConstantBuffer);
            this.uniformBuffer = uniformBuffer;

            // The storage image the ray generation shader writes, in the back buffer's format, for the
            // copy.
            const created = this.createOutput(device);
            const descriptorPool = Nri_CreateDescriptorPoolWithAccelerationStructures(device, queuedFrameNum, 0, queuedFrameNum, 0,
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
                const uniformView = Nri_CreateConstantBufferView(uniformBuffer, i * UBO_STRIDE, UBO_STRIDE);
                queuedFrame.uniformView = uniformView;
                const set = Nri_AllocateDescriptorSet(descriptorPool, layout, 0, 0);
                queuedFrame.set = set;
                if (!set || !uniformView) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(set, 0, 0, uniformView);
                Nri_UpdateDescriptor(set, 1, 0, topLevelASView);
                for (let b = 0; b < this.bufferViews.length; b++) {
                    Nri_UpdateDescriptor(set, 2, b, this.bufferViews[b]);
                }
                Nri_UpdateDescriptor(set, 3, 0, outputStorage);
            }

            if (this.test) {
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The sample's create_ray_tracing_pipeline and create_shader_binding_tables: ray generation, the
        // miss shaders (primary rays, then shadow rays) and one hit group. False (after printing why)
        // on failure.
        createRayTracingPipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, folder: string): boolean {
            const desc = Nri_CreateRayTracingPipelineDesc();
            Nri_RayTracingPipelineDescAddGroup(desc, Nri_RayTracingPipelineDescAddShader(desc, NriStage.RayGen, "raygen"), -1, -1);
            Nri_RayTracingPipelineDescAddGroup(desc, Nri_RayTracingPipelineDescAddShader(desc, NriStage.Miss, "miss"), -1, -1);
            Nri_RayTracingPipelineDescAddGroup(desc, Nri_RayTracingPipelineDescAddShader(desc, NriStage.Miss, "missShadow"), -1, -1);
            Nri_RayTracingPipelineDescAddGroup(desc, Nri_RayTracingPipelineDescAddShader(desc, NriStage.ClosestHit, "closesthit"), -1, -1);
            const pipeline = Nri_CreateRayTracingPipelineFromDesc(device, layout,
                `shaders/ray_tracing_reflection/${folder}/ray_tracing_reflection.bin`, desc, PAYLOAD_SIZE, ATTRIBUTE_SIZE,
                MAX_RECURSION_DEPTH);
            Nri_DestroyRayTracingPipelineDesc(desc);
            this.pipeline = pipeline;
            if (!pipeline) {
                console.log("Cannot initialize the ray tracing pipeline");
                return false;
            }

            const missGroups: int[] = [MISS_GROUP, SHADOW_MISS_GROUP];
            const hitGroups: int[] = [HIT_GROUP];
            this.shaderTable = Nri_CreateShaderTableFromGroups(device, this.queue, pipeline, RAYGEN_GROUP, Ref(missGroups[0]), missGroups.length,
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
        createModels(device: NriDeviceHandle): boolean {
            const vertexLists = [CUBE_VERTICES, PLANE_VERTICES, CUBE_VERTICES];
            const indexLists = [CUBE_INDICES, PLANE_INDICES, CUBE_INDICES];
            const matIndexLists = [CUBE_MAT_INDEX, PLANE_MAT_INDEX, CUBE_MAT_INDEX];
            const materialLists = [
                [MAT_RED, MAT_GREEN, MAT_BLUE, MAT_YELLOW, MAT_CYAN, MAT_MAGENTA],        // 6 color faces
                [MAT_GREY],
                [MAT_MIRROR],
            ];

            const vertices: f32[] = [];
            const indices: int[] = [];
            const matIndices: int[] = [];
            const materials: f32[] = [];
            const objDesc: int[] = [];
            for (let o = 0; o < vertexLists.length; o++) {
                objDesc.push(vertices.length / VERTEX_FLOATS);
                objDesc.push(indices.length);
                objDesc.push(matIndices.length);
                objDesc.push(materials.length / MATERIAL_FLOATS);
                const vertexList = vertexLists[o];
                for (const coordinate of vertexList) {
                    vertices.push(coordinate);
                }
                const indexList = indexLists[o];
                for (const index of indexList) {
                    indices.push(index);
                }
                const materialList = materialLists[o];
                const maxIndex = materialList.length - 1;
                const matIndexList = matIndexLists[o];
                for (const matIndex of matIndexList) {
                    matIndices.push(Math.min(maxIndex, matIndex));
                }
                for (const material of materialList) {
                    for (let i = 0; i < MATERIAL_FLOATS; i++) {
                        materials.push(material[i]);
                    }
                }
            }

            // The shaders' buffers, in register order (t1 to t5).
            const objDescBuffer = Nri_CreateUploadedStructuredBufferFromInts(device, this.queue, Ref(objDesc[0]), objDesc.length * 4, 16);
            const vertexBuffer = Nri_CreateUploadedStructuredBuffer(device, this.queue, Ref(vertices[0]), vertices.length * 4, 4);
            const indexBuffer = Nri_CreateUploadedStructuredBufferFromInts(device, this.queue, Ref(indices[0]), indices.length * 4, 4);
            const matIndexBuffer = Nri_CreateUploadedStructuredBufferFromInts(device, this.queue, Ref(matIndices[0]), matIndices.length * 4, 4);
            const materialBuffer = Nri_CreateUploadedStructuredBuffer(device, this.queue, Ref(materials[0]), materials.length * 4, 4);
            if (!objDescBuffer || !vertexBuffer || !indexBuffer || !matIndexBuffer || !materialBuffer) {
                console.log("Cannot create the scene's buffers");
                return false;
            }
            this.buffers = [objDescBuffer, vertexBuffer, indexBuffer, matIndexBuffer, materialBuffer];
            for (const buffer of this.buffers) {
                const view = Nri_CreateStructuredBufferView(buffer, 0);
                if (!view) {
                    console.log("Cannot create the scene's buffer views");
                    return false;
                }
                this.bufferViews.push(view);
            }

            for (let o = 0; o < vertexLists.length; o++) {
                const vertexList = vertexLists[o];
                const vertexCount = vertexList.length / VERTEX_FLOATS;
                const positions: f32[] = [];
                for (let v = 0; v < vertexCount; v++) {
                    for (let c = 0; c < 3; c++) {
                        positions.push(vertexList[v * VERTEX_FLOATS + c]);
                    }
                }
                const indexList: int[] = indexLists[o].map((i): int => i);
                const desc = Nri_CreateBlasDesc();
                Nri_BlasDescAddTriangles(desc, Ref(positions[0]), vertexCount, Ref(indexList[0]), indexList.length);
                const blas = Nri_BuildBlasFromDesc(device, this.queue, desc, NriAccelerationStructureFlags.PreferFastTrace);
                Nri_DestroyBlasDesc(desc);
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
        addInstance(topLevelAS: NriTopLevelASHandle, blasId: int, m: number[]) {
            for (let row = 0; row < 3; row++) {
                for (let column = 0; column < 4; column++) {
                    this.transform[row * 4 + column] = m[column * 4 + row];
                }
            }
            Nri_TopLevelASAddInstance(topLevelAS, this.blases[blasId], Ref(this.transform[0]), blasId, 0xFF, 0, INSTANCE_FLAGS_CULL_DISABLE);
        }

        // The rest of the sample's create_scene: the mirrors behind and in front, the floor below, the
        // two cubes side by side; built once (nothing moves). False (after printing why) on failure.
        createScene(device: NriDeviceHandle): boolean {
            const topLevelAS = Nri_CreateTopLevelAS(device, 5, NriAccelerationStructureFlags.PreferFastTrace, 1);
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

        // The camera's mouse handling: the buttons' changes, then the move.
        handleMouse() {
            for (let button = 0; button < 3; button++) {
                const pressed = Nri_IsButtonPressed(this.sample, button) != 0;
                if (pressed != this.buttons[button]) {
                    this.camera.mouseButton(<MouseButton>button, <Action>(pressed ? 1 : 0));
                    this.buttons[button] = pressed;
                }
            }
            this.mouseX += Nri_GetMouseDeltaX(this.sample);
            this.mouseY += Nri_GetMouseDeltaY(this.sample);
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
        recordRays(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame, frameIndex: int) {
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
            Nri_WriteBuffer(uniformBuffer, (frameIndex % this.queuedFrames.length) * UBO_STRIDE, Ref(this.ubo[0]), UBO_FLOATS * 4);

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

        // The output copied into the frame without conversion, as the sample's vkCmdCopyImage.
        recordCopy(commandBuffer: NriCommandBufferHandle, texture: NriTextureHandle) {
            const output = this.output;
            if (output) {
                Nri_CmdCopyTexture(commandBuffer, texture, output);
            }
        }

        // The swap chain at the window's size, its textures' semaphores.
        createSwapChain(device: NriDeviceHandle) {
            this.width = Nri_GetOutputWidth(this.sample);
            this.height = Nri_GetOutputHeight(this.sample);
            this.swapChain = Nri_CreateSwapChain(this.sample, device, this.queue, Nri_GetQueuedFrameNum(this.sample) + 1);
            const textureNum = Nri_GetSwapChainTextureNum(this.swapChain);
            this.swapChainFormat = Nri_GetTextureFormat(Nri_GetSwapChainTexture(this.swapChain, 0));
            for (let i = 0; i < textureNum; i++) {
                this.swapChainTextures.push(new SwapChainTexture(Nri_GetSwapChainTexture(this.swapChain, i),
                    Nri_CreateSwapChainSemaphore(device), Nri_CreateSwapChainSemaphore(device)));
            }
        }

        destroySwapChain() {
            for (const swapChainTexture of this.swapChainTextures) {
                Nri_DestroyFence(swapChainTexture.acquireSemaphore);
                Nri_DestroyFence(swapChainTexture.releaseSemaphore);
            }
            this.swapChainTextures = [];
            Nri_DestroySwapChain(this.swapChain);
        }

        // The storage image the ray generation shader writes, at the swap chain's size and in its format
        // (for the copy), and its view; false if the image can't be made. Once the sets exist, their
        // output slots point at the new view; it starts as made (the first frame's state).
        createOutput(device: NriDeviceHandle): boolean {
            const output = Nri_CreateStorageTexture(device, this.queue, this.width, this.height, this.swapChainFormat);
            this.output = output;
            if (!output) {
                return false;
            }
            const outputStorage = Nri_CreateStorageTextureView(output, this.swapChainFormat);
            this.outputStorage = outputStorage;
            if (outputStorage) {
                for (const queuedFrame of this.queuedFrames) {
                    const set = queuedFrame.set;
                    if (set) {
                        Nri_UpdateDescriptor(set, 3, 0, outputStorage);
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
                Nri_DestroyTexture(output);
            }
            this.output = null;
        }

        // The window was resized (Nri_UseResizableWindow): the swap chain and the ray traced output made again at its size, once the
        // GPU is done with the old ones.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (Nri_GetOutputWidth(this.sample) == this.width && Nri_GetOutputHeight(this.sample) == this.height) {
                return;
            }
            Nri_DeviceWaitIdle(device);
            this.destroyOutput();
            this.destroySwapChain();
            this.createSwapChain(device);
            this.createOutput(device);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrame = this.queuedFrames[frameIndex % this.queuedFrames.length];
            this.handleMouse();

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
                    this.destroyDescriptor(queuedFrame.uniformView);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    Nri_DestroyDescriptorPool(descriptorPool);
                }
                this.destroyOutput();
                this.destroyDescriptor(this.topLevelASView);
                for (const view of this.bufferViews) {
                    Nri_DestroyDescriptor(view);
                }
                for (const buffer of this.buffers) {
                    Nri_DestroyBuffer(buffer);
                }
                const uniformBuffer = this.uniformBuffer;
                if (uniformBuffer) {
                    Nri_DestroyBuffer(uniformBuffer);
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
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        Nri_UseResizableWindow(sample);
        return new RayTracingReflection(sample).run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return RayTracingReflectionNri.main(argc, argv);
}

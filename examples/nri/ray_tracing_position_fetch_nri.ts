/// <reference path="../../core/nri/nri_interop.d.ts" />
import { identity, multiply, rotate, inverseRigid, radians } from "../../core/matrix";

namespace RayTracingPositionFetchNri {
    // ray_tracing_position_fetch, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework
    // instead of Donut and NVRHI: the same shaders (ray_tracing_position_fetch.hlsl's library), through
    // the NRI calls core/nri/nri_interop.d.ts binds. This example creates everything it runs, and does
    // the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no ray tracing pipelines with
    // position fetch.
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Ray Tracing Position Fetch";

    // The sample's scene (Vulkan-Samples' assets, copied at build time, see
    // VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt): the Pica Pica robot, its meshes' positions only.
    const SCENE_PATH = "media/ray_tracing_position_fetch/pica_pica_robot/scene.gltf";

    // Nri_LoadGltfModel's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_FLOATS = 8;

    // The BLAS geometries' transform (a VkTransformMatrixKHR: 3 rows of 4): the robot mirrored in y
    // and moved 2 down, upright in the sample's world (-y up on the screen).
    const GEOMETRY_TRANSFORM: f32[] = [
        1.0, 0.0, 0.0, 0.0,
        0.0, -1.0, 0.0, 2.0,
        0.0, 0.0, 1.0, 0.0,
    ];
    const IDENTITY_TRANSFORM: f32[] = [
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
    ];
    // nri::TopLevelInstanceBits::TRIANGLE_CULL_DISABLE (VK_GEOMETRY_INSTANCE_TRIANGLE_FACING_CULL_DISABLE_BIT_KHR).
    const INSTANCE_FLAGS_CULL_DISABLE = 1;

    // struct UBO { float4x4 viewInverse, projInverse; int displayMode; }, padded.
    const UBO_VIEW_INVERSE = 0;
    const UBO_PROJ_INVERSE = 16;
    const UBO_DISPLAY_MODE = 32;
    const UBO_FLOATS = 36;
    // A constant buffer view's size is a multiple of 256 bytes (D3D12): a slice per frame in flight.
    const UBO_SLICE = 256;
    // The payload: float3 hitValue; the triangles' float2 barycentrics; primary rays only.
    const PAYLOAD_SIZE = 12;
    const ATTRIBUTE_SIZE = 8;

    // The sample's look-at camera, at (0, 0, -6.5) (the view's translation) turned 15 degrees
    // around y; a 60 degree vertical field of view, depth from 0.1 to 512.
    const CAMERA_TRANSLATION = [0.0, 0.0, -6.5];
    const CAMERA_ROTATION = [0.0, 15.0, 0.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 0.1;
    const Z_FAR = 512.0;

    const DISPLAY_MODE_NAMES = "Geometric normal|Vertex position";

    // The clear color around the model (the miss shader's (0, 0, 0.2)), as the checks read it
    // (0xBBGGRR).
    const BACKGROUND = 0x330000;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into, and its UBO slice's set.
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public uboView: NriDescriptorHandle | null, public set: NriDescriptorSetHandle | null) {
        }
    }

    // A swap chain texture, its color attachment view (sRGB, for the UI) and the semaphores of its
    // acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // core/test_check.ts' TestCheck over the pixels read back (0xAABBGGRR).
    class FrameCheck {
        constructor(public pixels: int[], public width: int, public height: int) {
        }

        rgb(x: int, y: int): int {
            return this.pixels[y * this.width + x] & 0xFFFFFF;
        }

        corners(rgb: int): string {
            if (this.pixels.length == 0) {
                return "cannot read the back buffer";
            }
            const xs = [0, this.width - 1, 0, this.width - 1];
            const ys = [0, 0, this.height - 1, this.height - 1];
            for (let k = 0; k < 4; k++) {
                const p = this.rgb(xs[k], ys[k]);
                if (p != rgb) {
                    return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not ${rgb & 0xFF}, ${(rgb >> 8) & 0xFF}, ${(rgb >> 16) & 0xFF}`;
                }
            }
            return "";
        }

        countOtherThan(rgb: int): int {
            let count = 0;
            for (let i = 0; i < this.width * this.height; i++) {
                if ((this.pixels[i] & 0xFFFFFF) != rgb) {
                    count++;
                }
            }
            return count;
        }

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

        share(count: int, total: int, min: number, max: number, what: string): string {
            const percent = 100.0 * count / total;
            console.log(`${what}: ${percent}% (${count} of ${total} pixels)`);
            if (percent < min || percent > max) {
                return `${what}: ${percent}% of the pixels, not ${min}% to ${max}%`;
            }
            return "";
        }
    }

    // -test: checks the last frame, as the Donut example does. The corners are the dark blue clear
    // color; the model, colored by the positions its hit shader fetches, covers about 22% of the frame.
    function checkFrame(pixels: int[], width: int, height: int) {
        const check = new FrameCheck(pixels, width, height);
        const corners = check.corners(BACKGROUND);
        if (corners != "") {
            return corners;
        }
        const total = width * height;
        const model = check.share(check.countOtherThan(BACKGROUND), total, 15.0, 30.0, "Model");
        if (model != "") {
            return model;
        }
        return check.share(check.countInRange(0, 89, 121, 255, 0, 89), total, 1.5, 5.0, "Green");
    }

    // --- Math (glm's layout: 4 x 4 matrices by columns) ---------------------------------------

    // inverse(glm::perspective(fov, aspect, near, far)) (right-handed, depth from 0 to 1).
    function inversePerspective(fov: number, aspect: number, zNear: number, zFar: number) {
        const tanHalfFovy = Math.tan(0.5 * fov);
        const p22 = zFar / (zNear - zFar);
        const p32 = -(zFar * zNear) / (zFar - zNear);
        return [
            aspect * tanHalfFovy, 0.0,         0.0,  0.0,
            0.0,                  tanHalfFovy, 0.0,  0.0,
            0.0,                  0.0,         0.0,  1.0 / p32,
            0.0,                  0.0,         -1.0, p22 / p32,
        ];
    }

    // The sample's camera (the framework's vkb::Camera, look-at type), with ApiVulkanSample's mouse
    // controls: the left button turns it, the right one zooms, the middle one pans.
    class SampleCamera {
        rotation: number[];
        position: number[];
        private mouseX: number;
        private mouseY: number;
        private buttons: boolean[];

        constructor() {
            this.rotation = [CAMERA_ROTATION[0], CAMERA_ROTATION[1], CAMERA_ROTATION[2]];
            this.position = [CAMERA_TRANSLATION[0], CAMERA_TRANSLATION[1], CAMERA_TRANSLATION[2]];
            this.mouseX = 0.0;
            this.mouseY = 0.0;
            this.buttons = [false, false, false];
        }

        // vkb::Camera::update_view_matrix: translate(position) * rotations around x, y, z.
        view() {
            let r = identity();
            r = rotate(r, radians(this.rotation[0]), 1.0, 0.0, 0.0);
            r = rotate(r, radians(this.rotation[1]), 0.0, 1.0, 0.0);
            r = rotate(r, radians(this.rotation[2]), 0.0, 0.0, 1.0);
            let t = identity();
            t[12] = this.position[0];
            t[13] = this.position[1];
            t[14] = this.position[2];
            return multiply(t, r);
        }

        // Buttons: 0 left, 1 right, 2 middle.
        mouseButton(button: int, pressed: boolean) {
            if (button >= 0 && button < 3) {
                this.buttons[button] = pressed;
            }
        }

        // ApiVulkanSample::handle_mouse_move, with its speeds (1).
        mouseMove(x: number, y: number) {
            const dx = Math.floor(this.mouseX) - Math.floor(x);
            const dy = Math.floor(this.mouseY) - Math.floor(y);
            if (this.buttons[0]) {
                this.rotation[0] += dy;
                this.rotation[1] -= dx;
            }
            if (this.buttons[1]) {
                this.position[2] += dy * 0.005;
            }
            if (this.buttons[2]) {
                this.position[0] -= dx * 0.01;
                this.position[1] -= dy * 0.01;
            }
            this.mouseX = x;
            this.mouseY = y;
        }
    }

    // --- The example --------------------------------------------------------------------------

    // Port of Vulkan-Samples' ray_tracing_position_fetch, as examples/ray_tracing_position_fetch.ts
    // ports it, to NRI: the robot's meshes in one bottom-level acceleration structure built so that hit
    // shaders can read its vertex positions (NriAccelerationStructureFlags.AllowDataAccess), ray traced;
    // the closest hit shader shows each hit triangle's geometric normal or the position hit, both from
    // the positions it fetches, not from vertex buffers. The rays write the back buffer's format,
    // copied into it; the display mode's UI drawn over it. Vulkan only
    // (VK_KHR_ray_tracing_position_fetch).
    class RayTracingPositionFetch {
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
        private uboBuffer: NriBufferHandle | null = null;
        private output: NriTextureHandle | null = null;
        private outputStorage: NriDescriptorHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private imgui: boolean = false;
        private viewFormat: NriFormat = NriFormat.Unknown;
        // The output was copied from (after the first frame).
        private outputCopied: boolean = false;
        private camera: SampleCamera = new SampleCamera();
        // The mouse as last seen (the camera's input, GLFW's callbacks being Donut's).
        private mouseX: number = -1.0;
        private mouseY: number = -1.0;
        private buttons: boolean[] = [false, false, false];
        private ubo: f32[] = [];
        private transform: f32[] = [];
        private width: int = 0;
        private height: int = 0;
        // Set by initialize when the example can't run ("" otherwise): wrongAPI when it needs Vulkan
        // (an error, as the Donut example's), else unsupported (a skip).
        private unsupportedReason: string = "";
        private wrongAPI: boolean = false;

        // The sample's display mode, from its UI: 0 geometric normal, 1 vertex position (-mode).
        displayMode: int = 0;
        // -noUI: no display mode window.
        noUI: boolean = false;

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
                this.transform.push(IDENTITY_TRANSFORM[i]);
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
            if (this.wrongAPI) {
                console.log(this.unsupportedReason);
                result = 1;
            } else if (this.unsupportedReason != "") {
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
            // Position fetch is Vulkan's (VK_KHR_ray_tracing_position_fetch); D3D12 has it only through
            // NVAPI's HLSL extensions, which the shaders don't use.
            if (graphicsAPI != NriGraphicsAPI.VK) {
                this.unsupportedReason = "This example needs Vulkan (-vk): it reads vertex positions in hit shaders, VK_KHR_ray_tracing_position_fetch";
                this.wrongAPI = true;
                return 0;
            }
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

            // Swap chain: copied into, in its own (UNORM) format (the shader writes the values the
            // sample's copy puts in its sRGB back buffer as they are); the UI drawn through sRGB views.
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.swapChain = Nri_CreateSwapChain(this.sample, device, this.queue, queuedFrameNum + 1);
            const textureNum = Nri_GetSwapChainTextureNum(this.swapChain);
            const format = Nri_GetTextureFormat(Nri_GetSwapChainTexture(this.swapChain, 0));
            const viewFormat = Nri_GetSrgbFormat(format);
            this.viewFormat = viewFormat;
            for (let i = 0; i < textureNum; i++) {
                const texture = Nri_GetSwapChainTexture(this.swapChain, i);
                this.swapChainTextures.push(new SwapChainTexture(texture, Nri_CreateColorAttachmentView(texture, viewFormat),
                    Nri_CreateSwapChainSemaphore(device), Nri_CreateSwapChainSemaphore(device)));
            }

            if (Nri_IsFeatureSupported(device, NriFeature.RayTracing) == 0
                || Nri_IsFeatureSupported(device, NriFeature.RayTracingPositionFetch) == 0) {
                this.unsupportedReason = "The graphics device has no ray tracing pipelines with position fetch (VK_KHR_ray_tracing_position_fetch)";
                return 0;
            }

            // The layout: the UBO (b0), the scene (t0) and the output (u0), for every ray tracing
            // stage.
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.RayTracing, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.AccelerationStructure, NriStage.RayTracing, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.StorageTexture, NriStage.RayTracing, NriRangeFlags.None);
            const layout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            this.layout = layout;
            if (!layout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }
            const pipeline = Nri_CreateRayTracingPipeline(device, layout,
                "shaders/ray_tracing_position_fetch/spirv/ray_tracing_position_fetch.bin", "raygen", "miss", "closesthit", PAYLOAD_SIZE,
                ATTRIBUTE_SIZE);
            this.pipeline = pipeline;
            if (!pipeline) {
                console.log("Cannot initialize the ray tracing pipeline");
                return 0;
            }
            this.shaderTable = Nri_CreateShaderTable(device, this.queue, pipeline, 1, 1);
            if (!this.shaderTable) {
                console.log("Cannot create the shader table");
                return 0;
            }

            if (!this.createBottomLevelAccelerationStructure(device)) {
                console.log("Cannot load the scene: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            const topLevelAS = Nri_CreateTopLevelAS(device, 1, NriAccelerationStructureFlags.None, queuedFrameNum);
            this.topLevelAS = topLevelAS;
            if (!topLevelAS) {
                console.log("Cannot create the top level acceleration structure");
                return 0;
            }
            const topLevelASView = Nri_CreateAccelerationStructureDescriptor(Nri_GetTopLevelAccelerationStructure(topLevelAS));
            this.topLevelASView = topLevelASView;

            // The output the ray generation shader writes, in the back buffer's format, for the copy.
            const output = Nri_CreateStorageTexture(device, this.queue, this.width, this.height, format);
            this.output = output;
            const uboBuffer = Nri_CreateHostBuffer(device, UBO_SLICE * queuedFrameNum, NriBufferUsage.ConstantBuffer);
            this.uboBuffer = uboBuffer;
            const descriptorPool = Nri_CreateDescriptorPoolWithAccelerationStructures(device, queuedFrameNum, 0, queuedFrameNum, 0,
                queuedFrameNum, 0, queuedFrameNum);
            this.descriptorPool = descriptorPool;
            if (!output || !uboBuffer || !descriptorPool || !topLevelASView) {
                console.log("Cannot create the output");
                return 0;
            }
            const outputStorage = Nri_CreateStorageTextureView(output, format);
            this.outputStorage = outputStorage;

            // Queued frames: each with its UBO slice's set.
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const uboView = Nri_CreateConstantBufferView(uboBuffer, i * UBO_SLICE, UBO_SLICE);
                const set = Nri_AllocateDescriptorSet(descriptorPool, layout, 0, 0);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), uboView, set));
                if (!uboView || !set) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(set, 0, 0, uboView);
                Nri_UpdateDescriptor(set, 1, 0, topLevelASView);
                Nri_UpdateDescriptor(set, 2, 0, outputStorage);
            }

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

        // The sample's create_bottom_level_acceleration_structure: every mesh's triangles (in mesh
        // space: the scene's node transforms aren't applied), each a geometry with the transform, in
        // one BLAS, its vertex positions readable by hit shaders. False on failure.
        createBottomLevelAccelerationStructure(device: NriDeviceHandle): boolean {
            const scene = Nri_LoadGltfModel(SCENE_PATH);
            if (!scene) {
                return false;
            }
            const desc = Nri_CreateBlasDesc();
            const primitiveCount = Nri_GetGltfModelPrimitiveCount(scene);
            for (let p = 0; p < primitiveCount; p++) {
                const vertexCount = Nri_GetGltfModelVertexCount(scene, p);
                const indexCount = Nri_GetGltfModelIndexCount(scene, p);
                const vertices: f32[] = [];
                for (let i = 0; i < vertexCount * VERTEX_FLOATS; i++) {
                    vertices.push(0.0);
                }
                const indices: int[] = [];
                for (let i = 0; i < indexCount; i++) {
                    indices.push(0);
                }
                Nri_CopyGltfModelVertices(scene, p, Ref(vertices[0]));
                Nri_CopyGltfModelIndices(scene, p, Ref(indices[0]));
                // The positions, the first 3 of each vertex's floats (the Donut example's BLAS reads
                // them VERTEX_SIZE bytes apart).
                const positions: f32[] = [];
                for (let v = 0; v < vertexCount; v++) {
                    positions.push(vertices[v * VERTEX_FLOATS]);
                    positions.push(vertices[v * VERTEX_FLOATS + 1]);
                    positions.push(vertices[v * VERTEX_FLOATS + 2]);
                }
                Nri_BlasDescAddTriangles(desc, Ref(positions[0]), vertexCount, Ref(indices[0]), indexCount);
                Nri_BlasDescSetTransform(desc, Ref(GEOMETRY_TRANSFORM[0]));
            }
            Nri_DestroyGltfModel(scene);
            const blas = Nri_BuildBlasFromDesc(device, this.queue, desc,
                NriAccelerationStructureFlags.AllowDataAccess | NriAccelerationStructureFlags.PreferFastTrace);
            Nri_DestroyBlasDesc(desc);
            this.blas = blas;
            if (!blas) {
                return false;
            }
            return true;
        }

        // Waits for the frame that last used this frame's command allocator (and UBO slice).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The mouse into the camera, as Donut's callbacks hand it over (not while the UI has it; none
        // in test mode).
        pollMouse() {
            if (this.test || (this.imgui && Nri_ImguiWantsMouse() != 0)) {
                return;
            }
            for (let b = 0; b < 3; b++) {
                const pressed = Nri_IsButtonPressed(this.sample, b) != 0;
                if (pressed != this.buttons[b]) {
                    this.buttons[b] = pressed;
                    this.camera.mouseButton(b, pressed);
                }
            }
            const x = Nri_GetMouseX(this.sample);
            const y = Nri_GetMouseY(this.sample);
            if (x != this.mouseX || y != this.mouseY) {
                this.mouseX = x;
                this.mouseY = y;
                this.camera.mouseMove(x, y);
            }
        }

        // The sample's display mode choice.
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPos(10.0, 10.0);
            Nri_ImguiBegin("Options", 1);
            this.displayMode = Nri_ImguiCombo("Display mode", this.displayMode, DISPLAY_MODE_NAMES);
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        // The sample's update_uniform_buffers into this frame's slice: inverse view and projection
        // matrices, the display mode.
        updateUniformBuffers(queuedFrameIndex: int) {
            const uboBuffer = this.uboBuffer;
            if (!uboBuffer) {
                return;
            }
            const viewInverse = inverseRigid(this.camera.view());
            const projInverse = inversePerspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR);
            const u = this.ubo;
            for (let i = 0; i < 16; i++) {
                u[UBO_VIEW_INVERSE + i] = viewInverse[i];
                u[UBO_PROJ_INVERSE + i] = projInverse[i];
            }
            Nri_StoreInt32(Ref(u[UBO_DISPLAY_MODE]), this.displayMode);
            Nri_WriteBuffer(uboBuffer, queuedFrameIndex * UBO_SLICE, Ref(u[0]), UBO_FLOATS * 4);
        }

        // The sample's top-level acceleration structure (the BLAS once, untransformed, both faces of
        // its triangles hit), built this frame, and the rays into the output, which then goes to the
        // copy.
        recordRays(commandBuffer: NriCommandBufferHandle, queuedFrameIndex: int) {
            const layout = this.layout;
            const pipeline = this.pipeline;
            const shaderTable = this.shaderTable;
            const descriptorPool = this.descriptorPool;
            const set = this.queuedFrames[queuedFrameIndex].set;
            const output = this.output;
            const topLevelAS = this.topLevelAS;
            const blas = this.blas;
            if (!layout || !pipeline || !shaderTable || !descriptorPool || !set || !output || !topLevelAS || !blas) {
                return;
            }
            Nri_TopLevelASClearInstances(topLevelAS);
            Nri_TopLevelASAddInstance(topLevelAS, blas, Ref(this.transform[0]), 0, 0xFF, 0, INSTANCE_FLAGS_CULL_DISABLE);
            Nri_CmdBuildTopLevelAS(commandBuffer, topLevelAS, queuedFrameIndex, 0);

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

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.pollMouse();

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: the TLAS and the rays, their output copied into the frame (without
                // conversion, as the sample's copy: the UNORM values become the back buffer's sRGB
                // encoded ones), then the UI over it.
                this.updateUniformBuffers(queuedFrameIndex);
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
                    this.destroyDescriptor(queuedFrame.uboView);
                }
                for (const swapChainTexture of this.swapChainTextures) {
                    Nri_DestroyDescriptor(swapChainTexture.colorAttachment);
                    Nri_DestroyFence(swapChainTexture.acquireSemaphore);
                    Nri_DestroyFence(swapChainTexture.releaseSemaphore);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    Nri_DestroyDescriptorPool(descriptorPool);
                }
                this.destroyDescriptor(this.outputStorage);
                this.destroyDescriptor(this.topLevelASView);
                const output = this.output;
                if (output) {
                    Nri_DestroyTexture(output);
                }
                const uboBuffer = this.uboBuffer;
                if (uboBuffer) {
                    Nri_DestroyBuffer(uboBuffer);
                }
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
        const example = new RayTracingPositionFetch(sample);
        // -mode <n>: display mode 0 (geometric normal) or 1 (vertex position); -noUI: no display mode
        // window.
        Nri_AddExampleOptionWithValues(sample, "-mode", 1);
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-mode" && i + 1 < argc) {
                // Clamped to 0 or 1 (tslang's Math.max is wrong for negative numbers).
                const mode = parseInt(Nri_GetArg(argc, argv, i + 1));
                example.displayMode = mode < 0 ? 0 : (mode > 1 ? 1 : mode);
                i++;
            } else if (arg == "-noUI") {
                example.noUI = true;
            }
        }
        return example.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return RayTracingPositionFetchNri.main(argc, argv);
}

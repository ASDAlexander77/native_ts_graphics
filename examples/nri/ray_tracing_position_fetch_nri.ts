/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { identity, multiply, rotate, inverseRigid, radians } from "../../core/matrix";
import { Nri, NriAccelerationStructure, NriBlasDesc, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriGltfModel, NriImgui, NriPipeline, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriShaderTable, NriTexture, NriTopLevelAS } from "../../core/nri";

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

    // NriGltfModel.load's vertices: float3 position, float3 normal, float2 texture coordinates.
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

    // A frame in flight's own data: its UBO slice's set.
    class QueuedFrame {
        constructor(public uboView: NriDescriptor | null, public set: NriDescriptorSet | null) {
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
        private uboBuffer: NriBuffer | null = null;
        private output: NriTexture | null = null;
        private outputStorage: NriDescriptor | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private imgui: boolean = false;
        // The swap chain textures' format (its views' are viewFormat).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
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
        // The swap chain's size: the window's when it was (re)created.
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
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
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
            this.sample.setInitializeCallback(initialize);
            this.sample.setLatencySleepCallback(latencySleep);
            this.sample.setRenderFrameCallback(renderFrame);

            // On a wrapper of its own: the callbacks Nri_RunSample runs may overwrite this.sample.
            let result = new NriSample(this.sample.handle).run(argc, argv, WINDOW_TITLE, TEST_FRAMES);
            if (this.wrongAPI) {
                console.log(this.unsupportedReason);
                result = 1;
            } else if (this.unsupportedReason != "") {
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
            // Position fetch is Vulkan's (VK_KHR_ray_tracing_position_fetch); D3D12 has it only through
            // NVAPI's HLSL extensions, which the shaders don't use.
            if (graphicsAPI != NriGraphicsAPI.VK) {
                this.unsupportedReason = "This example needs Vulkan (-vk): it reads vertex positions in hit shaders, VK_KHR_ray_tracing_position_fetch";
                this.wrongAPI = true;
                return 0;
            }
            const device = this.sample.createDevice(graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri.getGraphicsAPIString(graphicsAPI)} (${device.getAdapterName()})`);

            this.queue = device.getGraphicsQueue();
            this.test = this.sample.isTest() != 0;

            // Swap chain: copied into, in its own (UNORM) format (the shader writes the values the
            // sample's copy puts in its sRGB back buffer as they are); the UI drawn through sRGB views.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.viewFormat;

            if (device.isFeatureSupported(NriFeature.RayTracing) == 0
                || device.isFeatureSupported(NriFeature.RayTracingPositionFetch) == 0) {
                this.unsupportedReason = "The graphics device has no ray tracing pipelines with position fetch (VK_KHR_ray_tracing_position_fetch)";
                return 0;
            }

            // The layout: the UBO (b0), the scene (t0) and the output (u0), for every ray tracing
            // stage.
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.RayTracing, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.AccelerationStructure, NriStage.RayTracing, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.StorageTexture, NriStage.RayTracing, NriRangeFlags.None);
            const layout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
            this.layout = layout;
            if (!layout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }
            const pipeline = device.createRayTracingPipeline(layout,
                "shaders/ray_tracing_position_fetch/spirv/ray_tracing_position_fetch.bin", "raygen", "miss", "closesthit", PAYLOAD_SIZE,
                ATTRIBUTE_SIZE);
            this.pipeline = pipeline;
            if (!pipeline) {
                console.log("Cannot initialize the ray tracing pipeline");
                return 0;
            }
            this.shaderTable = device.createShaderTable(this.queue, pipeline, 1, 1);
            if (!this.shaderTable) {
                console.log("Cannot create the shader table");
                return 0;
            }

            if (!this.createBottomLevelAccelerationStructure(device)) {
                console.log("Cannot load the scene: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            const topLevelAS = device.createTopLevelAS(1, NriAccelerationStructureFlags.None, queuedFrameNum);
            this.topLevelAS = topLevelAS;
            if (!topLevelAS) {
                console.log("Cannot create the top level acceleration structure");
                return 0;
            }
            const topLevelASView = topLevelAS.getTopLevelAccelerationStructure().createDescriptor();
            this.topLevelASView = topLevelASView;

            // The output the ray generation shader writes, in the back buffer's format, for the copy.
            const created = this.createOutput(device);
            const uboBuffer = device.createHostBuffer(UBO_SLICE * queuedFrameNum, NriBufferUsage.ConstantBuffer);
            this.uboBuffer = uboBuffer;
            const descriptorPool = device.createDescriptorPoolWithAccelerationStructures(queuedFrameNum, 0, queuedFrameNum, 0,
                queuedFrameNum, 0, queuedFrameNum);
            this.descriptorPool = descriptorPool;
            if (!created || !uboBuffer || !descriptorPool || !topLevelASView) {
                console.log("Cannot create the output");
                return 0;
            }
            const outputStorage = this.outputStorage;

            // Queued frames: each with its UBO slice's set.
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const uboView = uboBuffer.createConstantView(i * UBO_SLICE, UBO_SLICE);
                const set = descriptorPool.allocateDescriptorSet(layout, 0, 0);
                this.queuedFrames.push(new QueuedFrame(uboView, set));
                if (!uboView || !set) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                set.updateDescriptor(0, 0, uboView);
                set.updateDescriptor(1, 0, topLevelASView);
                set.updateDescriptor(2, 0, outputStorage);
            }

            if (!this.noUI) {
                if (this.sample.initImgui(device) == 0) {
                    console.log("Cannot initialize the user interface");
                    return 0;
                }
                this.imgui = true;
            }

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The sample's create_bottom_level_acceleration_structure: every mesh's triangles (in mesh
        // space: the scene's node transforms aren't applied), each a geometry with the transform, in
        // one BLAS, its vertex positions readable by hit shaders. False on failure.
        createBottomLevelAccelerationStructure(device: NriDevice): boolean {
            const scene = NriGltfModel.load(SCENE_PATH);
            if (!scene) {
                return false;
            }
            const desc = NriBlasDesc.create();
            const primitiveCount = scene.getPrimitiveCount();
            for (let p = 0; p < primitiveCount; p++) {
                const vertexCount = scene.getVertexCount(p);
                const indexCount = scene.getIndexCount(p);
                const vertices: f32[] = [];
                for (let i = 0; i < vertexCount * VERTEX_FLOATS; i++) {
                    vertices.push(0.0);
                }
                const indices: int[] = [];
                for (let i = 0; i < indexCount; i++) {
                    indices.push(0);
                }
                scene.copyVertices(p, Ref(vertices[0]));
                scene.copyIndices(p, Ref(indices[0]));
                // The positions, the first 3 of each vertex's floats (the Donut example's BLAS reads
                // them VERTEX_SIZE bytes apart).
                const positions: f32[] = [];
                for (let v = 0; v < vertexCount; v++) {
                    positions.push(vertices[v * VERTEX_FLOATS]);
                    positions.push(vertices[v * VERTEX_FLOATS + 1]);
                    positions.push(vertices[v * VERTEX_FLOATS + 2]);
                }
                desc.addTriangles(Ref(positions[0]), vertexCount, Ref(indices[0]), indexCount);
                desc.setTransform(Ref(GEOMETRY_TRANSFORM[0]));
            }
            scene.destroy();
            const blas = device.buildBlasFromDesc(this.queue, desc,
                NriAccelerationStructureFlags.AllowDataAccess | NriAccelerationStructureFlags.PreferFastTrace);
            desc.destroy();
            this.blas = blas;
            if (!blas) {
                return false;
            }
            return true;
        }

        // Waits for the frame that last used this frame's command allocator (and UBO slice).
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The mouse into the camera, as Donut's callbacks hand it over (not while the UI has it; none
        // in test mode).
        pollMouse() {
            if (this.test || (this.imgui && NriImgui.wantsMouse() != 0)) {
                return;
            }
            for (let b = 0; b < 3; b++) {
                const pressed = this.sample.isButtonPressed(b) != 0;
                if (pressed != this.buttons[b]) {
                    this.buttons[b] = pressed;
                    this.camera.mouseButton(b, pressed);
                }
            }
            const x = this.sample.getMouseX();
            const y = this.sample.getMouseY();
            if (x != this.mouseX || y != this.mouseY) {
                this.mouseX = x;
                this.mouseY = y;
                this.camera.mouseMove(x, y);
            }
        }

        // The sample's display mode choice.
        buildUI() {
            this.sample.imguiNewFrame();
            NriImgui.setNextWindowPos(10.0, 10.0);
            NriImgui.begin("Options", 1);
            this.displayMode = NriImgui.combo("Display mode", this.displayMode, DISPLAY_MODE_NAMES);
            NriImgui.end();
            this.sample.imguiRender();
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
            Nri.storeInt32(Ref(u[UBO_DISPLAY_MODE]), this.displayMode);
            uboBuffer.write(queuedFrameIndex * UBO_SLICE, Ref(u[0]), UBO_FLOATS * 4);
        }

        // The sample's top-level acceleration structure (the BLAS once, untransformed, both faces of
        // its triangles hit), built this frame, and the rays into the output, which then goes to the
        // copy.
        recordRays(commandBuffer: NriCommandBuffer, queuedFrameIndex: int) {
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
            topLevelAS.clearInstances();
            topLevelAS.addInstance(blas, Ref(this.transform[0]), 0, 0xFF, 0, INSTANCE_FLAGS_CULL_DISABLE);
            commandBuffer.buildTopLevelAS(topLevelAS, queuedFrameIndex, 0);

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

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The output the ray generation shader writes, at the swap chain's size and in its format (for
        // the copy), and its view; false if the output can't be made. Once the sets exist, their output
        // slots point at the new view; it starts as made (the first frame's state).
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
                        set.updateDescriptor(2, 0, outputStorage);
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
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            if (this.imgui) {
                this.buildUI();
            }
            this.pollMouse();

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: the TLAS and the rays, their output copied into the frame (without
                // conversion, as the sample's copy: the UNORM values become the back buffer's sRGB
                // encoded ones), then the UI over it.
                this.updateUniformBuffers(queuedFrameIndex);
                commandBuffer.begin();
                this.recordRays(commandBuffer, queuedFrameIndex);
                if (this.imgui) {
                    this.sample.copyImguiData(commandBuffer);
                }
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.CopyDestination);
                const output = this.output;
                if (output) {
                    commandBuffer.copyTexture(texture, output);
                }
                let presentFrom = NriTextureState.CopyDestination;
                if (this.imgui) {
                    commandBuffer.textureBarrier(texture, NriTextureState.CopyDestination, NriTextureState.ColorAttachment);
                    commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                    this.sample.drawImgui(commandBuffer, this.viewFormat);
                    commandBuffer.endRendering();
                    presentFrom = NriTextureState.ColorAttachment;
                }

                // The test's last frame: read back
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    if (frameIndex == TEST_FRAMES - 1) {
                        commandBuffer.textureBarrier(texture, presentFrom, NriTextureState.CopySource);
                        commandBuffer.readbackTextureToBuffer(readbackBuffer, this.rowPitch, texture, this.width, this.height);
                        presentFrom = NriTextureState.CopySource;
                    }
                }
                commandBuffer.textureBarrier(texture, presentFrom, NriTextureState.Present);
                commandBuffer.end();

                // Submit and present
                this.swapChain.submit(commandBuffer, index);
                if (this.imgui) {
                    this.sample.imguiEndFrame();
                }
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
                if (this.imgui) {
                    this.sample.destroyImgui();
                }
                for (const queuedFrame of this.queuedFrames) {
                    this.destroyDescriptor(queuedFrame.uboView);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                this.destroyOutput();
                this.destroyDescriptor(this.topLevelASView);
                const uboBuffer = this.uboBuffer;
                if (uboBuffer) {
                    uboBuffer.destroy();
                }
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
        const example = new RayTracingPositionFetch(sample);
        // -mode <n>: display mode 0 (geometric normal) or 1 (vertex position); -noUI: no display mode
        // window.
        sample.addExampleOptionWithValues("-mode", 1);
        sample.addExampleOption("-noUI");
        sample.useImgui();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-mode" && i + 1 < argc) {
                // Clamped to 0 or 1 (tslang's Math.max is wrong for negative numbers).
                const mode = parseInt(Nri.getArg(argc, argv, i + 1));
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

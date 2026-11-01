/// <reference path="../../core/nri/nri_interop.d.ts" />
import { rotate, radians, perspective, translation } from "../../core/matrix";
import { LookAtCamera } from "../../core/vulkan_samples_camera";

namespace PushDescriptorsNri {
    // push_descriptors, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the sample's shaders as push_descriptors_nri.hlsl has them (push_descriptors.hlsl's
    // with NRI's registers: see there), the same cube and textures, through the NRI calls
    // core/nri/nri_interop.d.ts binds, as basic_triangle_nri draws, with NRIFramework's ImGui for the
    // sample's overlay. This example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered, each 1/60 s.
    const TEST_FRAMES = 10;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): not Vulkan, or no push descriptors.
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Push Descriptors";

    // The sample's cube and textures (Vulkan-Samples' assets: the cube fragment_shading_rate's copy,
    // the KTX textures converted to DDS at build time, see VULKAN_SAMPLES_ASSETS_DIR in
    // CMakeLists.txt), the textures as sRGB as the framework loads color textures.
    const CUBE_PATH = "media/fragment_shading_rate/textured_unit_cube.gltf";
    const TEXTURE_PATHS = [
        "media/push_descriptors/crate01_color_height_rgba.dds",
        "media/push_descriptors/crate02_color_height_rgba.dds",
    ];

    // Nri_LoadGltfMesh's vertices: float3 position, float3 normal, float2 uv.
    const VERTEX_SIZE = 32;
    const UV_OFFSET = 24;

    // struct UBOScene { float4x4 projection, view; }; struct UBOModel { float4x4 local; }: a queued
    // frame's scene and two cubes' each in a constant buffer view of 256 bytes (D3D12's alignment),
    // FRAME_CONSTANTS_STRIDE bytes apart, bound as root descriptors at their offsets.
    const SCENE_FLOATS = 32;
    const MODEL_FLOATS = 16;
    const CONSTANT_VIEW_SIZE = 256;
    const FRAME_CONSTANTS_STRIDE = 3 * CONSTANT_VIEW_SIZE;

    // The two cubes: their positions, the axis each turns around (x, then y) and how fast (degrees
    // a second).
    const CUBE_POSITIONS = [-2.0, 0.0, 0.0, 1.5, 0.5, 0.0];
    const CUBE_SPEEDS = [2.5, 2.0];

    // The sample's look-at camera, 5 units back, a 60 degree vertical field of view, depth reversed
    // (near 512, far 0.1, as the sample passes them).
    const CAMERA_POSITION = [0.0, 0.0, -5.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 512.0;
    const Z_FAR = 0.1;

    // ApiVulkanSample's default_clear_color.
    const CLEAR_COLOR = 0.002;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into.
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // A cube's texture, its view and the descriptor set holding it with the sampler.
    class CubeTexture {
        constructor(public texture: NriTextureHandle, public view: NriDescriptorHandle, public descriptorSet: NriDescriptorSetHandle | null) {
        }
    }

    // -test: checks the last frame, read back, as the Donut example does: the corners are the clear
    // color; both cubes show their textures (the left and right halves of the frame's middle row
    // differ from the background, a twentieth of its width or more each).
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const background = pixels[0] & 0xFFFFFF;
        const row = Math.floor(height / 2) * width;
        let left = 0;
        let right = 0;
        for (let x = 0; x < width; x++) {
            if ((pixels[row + x] & 0xFFFFFF) != background) {
                if (x < width / 2) {
                    left++;
                } else {
                    right++;
                }
            }
        }
        console.log(`Cube pixels on the middle row: left ${left}, right ${right}`);
        if (left < width / 20 || right < width / 20) {
            return "a cube is missing";
        }
        return "";
    }

    // Port of Vulkan-Samples' push_descriptors (as examples/push_descriptors.ts ports it) to NRI: two
    // textured cubes drawn with one pipeline whose uniform buffers are never in an allocated
    // descriptor set: each draw's (the scene's, the cube's) are pushed into the command buffer right
    // before it. NRI's root descriptors are push descriptors on Vulkan (vkCmdPushDescriptorSetKHR), so
    // they are the sample's. NRI has no combined image samplers: each cube's texture and the sampler
    // are an ordinary descriptor set's (allocated once), bound with it. Vulkan only, as the sample and
    // the Donut example. The left mouse button turns the camera, the wheel zooms it.
    class PushDescriptors {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private depthTexture: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private layout: NriPipelineLayoutHandle | null = null;
        private pipeline: NriPipelineHandle | null = null;
        private cube: NriGltfMeshHandle | null = null;
        private cubeTextures: CubeTexture[] = [];
        private sampler: NriDescriptorHandle | null = null;
        private constantBuffer: NriBufferHandle | null = null;
        private sceneView: NriDescriptorHandle | null = null;
        private modelView: NriDescriptorHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        private camera: LookAtCamera = new LookAtCamera(CAMERA_POSITION, [0.0, 0.0, 0.0]);
        // The mouse, as the camera sees it: its position (summed from its moves) and buttons.
        private mouseX: number = 0.0;
        private mouseY: number = 0.0;
        private buttons: boolean[] = [false, false, false];

        // The cubes' turns (degrees).
        private rotations: number[] = [0.0, 0.0];

        // Upload buffers.
        private scene: f32[] = [];
        private model: f32[] = [];

        // The sample's setting (-noanimate: the cubes don't turn), from its UI; the device's limit
        // it shows; -noUI: no overlay.
        animate: boolean = true;
        maxPushDescriptors: int = 0;
        noUI: boolean = false;

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < SCENE_FLOATS; i++) {
                this.scene.push(0.0);
            }
            for (let i = 0; i < MODEL_FLOATS; i++) {
                this.model.push(0.0);
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

            // Swap chain: rendered through sRGB views, as into Donut's sRGB back buffers.
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

            // Queued frames
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator)));
            }

            // Push descriptors are Vulkan's (VK_KHR_push_descriptor, which NRI's root descriptors
            // use): the shaders are SPIR-V only, as the Donut example's.
            if (graphicsAPI != NriGraphicsAPI.VK) {
                this.unsupportedReason = "The Push Descriptors example can only run on Vulkan API.";
                return 0;
            }
            this.maxPushDescriptors = Nri_GetRootDescriptorMaxNum(device);
            if (this.maxPushDescriptors == 0) {
                this.unsupportedReason = "The device doesn't support push descriptors (VK_KHR_push_descriptor).";
                return 0;
            }

            // The depth buffer: D32, cleared to 0 (the sample's reversed depth).
            const depthTexture = Nri_CreateDepthTexture(device, this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
                console.log("Cannot create the depth buffer");
                return 0;
            }
            this.depthAttachment = Nri_CreateDepthAttachmentView(depthTexture, NriFormat.D32_SFLOAT);

            // load_assets: the cube and its textures (sRGB); ApiVulkanSample::load_texture's
            // sampler: trilinear, repeating, all the levels, the device's widest anisotropic
            // filtering.
            this.cube = Nri_LoadGltfMesh(device, this.queue, CUBE_PATH);
            const textures: NriTextureHandle[] = [];
            for (let i = 0; i < 2; i++) {
                const texture = Nri_LoadDdsTexture(device, this.queue, TEXTURE_PATHS[i], 1);
                if (texture) {
                    textures.push(texture);
                    this.cubeTextures.push(new CubeTexture(texture, Nri_CreateTextureView(texture, NriFormat.RGBA8_SRGB), null));
                }
            }
            if (!this.cube || this.cubeTextures.length != 2) {
                console.log("Cannot load the cube and textures: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            const sampler = Nri_CreateSamplerWithMipFilter(device, NriFilter.Linear, NriFilter.Linear, NriAddressMode.Repeat,
                Nri_GetMaxSamplerAnisotropy(device));
            this.sampler = sampler;
            if (!sampler) {
                console.log("Cannot create the sampler");
                return 0;
            }

            // The sample's setup_descriptor_set_layout: the scene's and the cube's uniform buffers
            // (b0, b1: the vertex shader's) pushed, as root descriptors; the texture and sampler (t0,
            // s0 in space 1: the pixel shader's) in a set of their own.
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootDescriptor(layoutDesc, 0, NriDescriptorType.ConstantBuffer, NriStage.Vertex);
            Nri_PipelineLayoutDescAddRootDescriptor(layoutDesc, 1, NriDescriptorType.ConstantBuffer, NriStage.Vertex);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescSetRegisterSpace(layoutDesc, 0, 1);
            const layout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            this.layout = layout;
            if (!layout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The sample's prepare_pipelines: position and texture coordinates; back faces
            // (counter-clockwise ones) culled, depth tested (greater: reversed) and written.
            const shaders = "shaders/push_descriptors_nri/spirv/push_descriptors_nri";
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_cube_vs.bin`, "cube_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_cube_ps.bin`, "cube_ps") != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescAddVertexAttribute(desc, "TEXCOORD", NriFormat.RG32_SFLOAT, UV_OFFSET);
            Nri_PipelineDescSetCullMode(desc, NriCullMode.Back);
            Nri_PipelineDescSetColor(desc, viewFormat, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.Greater, 1, 0);
            if (loaded) {
                this.pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            if (!this.pipeline) {
                console.log("Cannot load the push descriptors shaders");
                return 0;
            }

            // prepare_uniform_buffers: a queued frame's scene and cubes' each, in one buffer the CPU
            // writes; one view of each kind, bound at the frame's (and the cube's) offset.
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * FRAME_CONSTANTS_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            if (!constantBuffer) {
                console.log("Cannot create the uniform buffers");
                return 0;
            }
            this.sceneView = Nri_CreateConstantBufferView(constantBuffer, 0, CONSTANT_VIEW_SIZE);
            this.modelView = Nri_CreateConstantBufferView(constantBuffer, 0, CONSTANT_VIEW_SIZE);

            // Each cube's texture with the sampler, in a set allocated once.
            const descriptorPool = Nri_CreateDescriptorPool(device, 2, 2, 0, 2, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!descriptorPool) {
                console.log("Cannot create the descriptor pool");
                return 0;
            }
            for (const cubeTexture of this.cubeTextures) {
                const descriptorSet = Nri_AllocateDescriptorSet(descriptorPool, layout, 0, 0);
                cubeTexture.descriptorSet = descriptorSet;
                if (!descriptorSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(descriptorSet, 0, 0, cubeTexture.view);
                Nri_UpdateDescriptor(descriptorSet, 1, 0, sampler);
            }

            // The sample's overlay.
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

        // Waits for the frame that last used this frame's command allocator (and its constants).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The camera's mouse handling, unless the overlay has the mouse: the buttons' changes, the
        // move, the wheel.
        handleMouse() {
            const overlay = this.imgui && Nri_ImguiWantsMouse() != 0;
            for (let button = 0; button < 3; button++) {
                const pressed = Nri_IsButtonPressed(this.sample, button) != 0;
                if (pressed != this.buttons[button]) {
                    if (!pressed || !overlay) {
                        this.camera.mouseButton(<MouseButton>button, <Action>(pressed ? 1 : 0));
                    }
                    this.buttons[button] = pressed;
                }
            }
            this.mouseX += Nri_GetMouseDeltaX(this.sample);
            this.mouseY += Nri_GetMouseDeltaY(this.sample);
            this.camera.mouseMove(this.mouseX, this.mouseY);
            const wheel = Nri_GetMouseWheel(this.sample);
            if (wheel != 0.0 && !overlay) {
                this.camera.mouseScroll(wheel);
            }
        }

        // The sample's overlay.
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPos(10.0, 10.0);
            Nri_ImguiBegin("Push descriptors", 1);
            if (Nri_ImguiCollapsingHeader("Settings", 1) != 0) {
                this.animate = Nri_ImguiCheckbox("Animate", this.animate ? 1 : 0) != 0;
            }
            if (Nri_ImguiCollapsingHeader("Device properties", 1) != 0) {
                Nri_ImguiText(`maxPushDescriptors: ${this.maxPushDescriptors}`);
            }
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        // The sample's update_uniform_buffers (its projection, clip y negated as the Donut example
        // gives it, and view) and update_cube_uniform_buffers (each cube's model matrix, then,
        // animated, its turn advanced by deltaTime for the next frame), into this frame's constants.
        writeConstants(queuedFrameIndex: int, deltaTime: number) {
            const constantBuffer = this.constantBuffer;
            if (!constantBuffer) {
                return;
            }
            const offset = queuedFrameIndex * FRAME_CONSTANTS_STRIDE;
            const projection = perspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR);
            const view = this.camera.view();
            for (let i = 0; i < 16; i++) {
                this.scene[i] = i % 4 == 1 ? -projection[i] : projection[i];
                this.scene[16 + i] = view[i];
            }
            Nri_WriteBuffer(constantBuffer, offset, Ref(this.scene[0]), SCENE_FLOATS * 4);
            for (let i = 0; i < 2; i++) {
                let m = translation(CUBE_POSITIONS[i * 3], CUBE_POSITIONS[i * 3 + 1], CUBE_POSITIONS[i * 3 + 2]);
                const rx = i == 0 ? this.rotations[0] : 0.0;
                const ry = i == 1 ? this.rotations[1] : 0.0;
                m = rotate(m, radians(rx), 1.0, 0.0, 0.0);
                m = rotate(m, radians(ry), 0.0, 1.0, 0.0);
                m = rotate(m, 0.0, 0.0, 0.0, 1.0);
                for (let k = 0; k < 16; k++) {
                    this.model[k] = m[k];
                }
                Nri_WriteBuffer(constantBuffer, offset + (1 + i) * CONSTANT_VIEW_SIZE, Ref(this.model[0]), MODEL_FLOATS * 4);
            }
            if (this.animate) {
                for (let i = 0; i < 2; i++) {
                    this.rotations[i] += CUBE_SPEEDS[i] * deltaTime;
                    if (this.rotations[i] > 360.0) {
                        this.rotations[i] -= 360.0;
                    }
                }
            }
        }

        // Two cubes, each with its uniform buffers pushed (no set allocated for them) and its
        // texture's set bound (between Nri_CmdBeginRenderingWithDepth and Nri_CmdEndRendering).
        recordDraw(commandBuffer: NriCommandBufferHandle, queuedFrameIndex: int) {
            const layout = this.layout;
            const pipeline = this.pipeline;
            const cube = this.cube;
            const descriptorPool = this.descriptorPool;
            const sceneView = this.sceneView;
            const modelView = this.modelView;
            if (!layout || !pipeline || !cube || !descriptorPool || !sceneView || !modelView) {
                return;
            }
            const offset = queuedFrameIndex * FRAME_CONSTANTS_STRIDE;
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, layout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetIndexBuffer(commandBuffer, Nri_GetGltfMeshIndexBuffer(cube), 0, NriIndexType.UInt32);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, Nri_GetGltfMeshVertexBuffer(cube), 0, VERTEX_SIZE);
            for (let i = 0; i < 2; i++) {
                const descriptorSet = this.cubeTextures[i].descriptorSet;
                if (!descriptorSet) {
                    return;
                }
                Nri_CmdSetRootDescriptor(commandBuffer, 0, sceneView, offset);
                Nri_CmdSetRootDescriptor(commandBuffer, 1, modelView, offset + (1 + i) * CONSTANT_VIEW_SIZE);
                Nri_CmdSetDescriptorSet(commandBuffer, 0, descriptorSet);
                Nri_CmdDrawIndexed(commandBuffer, Nri_GetGltfMeshIndexCount(cube), 1, 0, 0, 0);
            }
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.handleMouse();
            // In test mode 1/60 second a frame in float32, as Donut's test mode passes it.
            this.writeConstants(queuedFrameIndex, Math.fround(this.test ? 1.0 / 60.0 : Nri_GetFrameTime(this.sample)));

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: color cleared to the default clear color, depth to 0; the cubes; then the
                // overlay over them.
                Nri_BeginCommandBuffer(commandBuffer);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    Nri_CmdBeginRenderingWithDepth(commandBuffer, swapChainTexture.colorAttachment, depthAttachment);
                    Nri_CmdClearColor(commandBuffer, CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
                    Nri_CmdClearDepth(commandBuffer, 0.0);
                    this.recordDraw(commandBuffer, queuedFrameIndex);
                    Nri_CmdEndRendering(commandBuffer);
                }
                // (A pass of its own: the UI's pipeline has no depth attachment.)
                if (this.imgui) {
                    Nri_CmdCopyImguiData(this.sample, commandBuffer);
                    Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
                    Nri_CmdDrawImgui(this.sample, commandBuffer, this.viewFormat);
                    Nri_CmdEndRendering(commandBuffer);
                }

                // The test's last frame: read back
                let presentFrom = NriTextureState.ColorAttachment;
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    if (frameIndex == TEST_FRAMES - 1) {
                        Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.ColorAttachment, NriTextureState.CopySource);
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
                }
                for (const swapChainTexture of this.swapChainTextures) {
                    Nri_DestroyFence(swapChainTexture.acquireSemaphore);
                    Nri_DestroyFence(swapChainTexture.releaseSemaphore);
                    Nri_DestroyDescriptor(swapChainTexture.colorAttachment);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    Nri_DestroyDescriptorPool(descriptorPool);
                }
                for (const cubeTexture of this.cubeTextures) {
                    Nri_DestroyDescriptor(cubeTexture.view);
                    Nri_DestroyTexture(cubeTexture.texture);
                }
                this.destroyDescriptor(this.sceneView);
                this.destroyDescriptor(this.modelView);
                this.destroyDescriptor(this.sampler);
                this.destroyDescriptor(this.depthAttachment);
                const depthTexture = this.depthTexture;
                if (depthTexture) {
                    Nri_DestroyTexture(depthTexture);
                }
                const cube = this.cube;
                if (cube) {
                    Nri_DestroyGltfMesh(cube);
                }
                this.destroyBuffer(this.constantBuffer);
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
        const pushDescriptors = new PushDescriptors(sample);
        // -noanimate: the cubes don't turn; -noUI: no overlay.
        Nri_AddExampleOption(sample, "-noanimate");
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-noanimate") {
                pushDescriptors.animate = false;
            } else if (arg == "-noUI") {
                pushDescriptors.noUI = true;
            }
        }
        return pushDescriptors.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return PushDescriptorsNri.main(argc, argv);
}

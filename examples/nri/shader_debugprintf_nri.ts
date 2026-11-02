/// <reference path="../../core/nri/nri_interop.d.ts" />
import { identity, multiply, rotate, radians, perspective } from "../../core/matrix";

namespace ShaderDebugPrintfNri {
    // shader_debugprintf, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (shader_debugprintf.hlsl's SPIR-V), model (read as Donut's
    // loadGltfMesh reads it) and texture, through the NRI calls core/nri/nri_interop.d.ts binds, with
    // NRIFramework's ImGui for the sample's overlay. This example creates everything it runs, and
    // does the rendering.

    // Test mode: the frames rendered, each 1/60 s; the layer reads a frame's output back once the
    // GPU has finished it, a frame or two later.
    const TEST_FRAMES = 10;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no validation layer for printf.
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Shader debugprintf";

    // The sample's model and texture (Vulkan-Samples' assets, fragment_shading_rate_dynamic's
    // copies: the KTX texture converted to DDS at build time, see VULKAN_SAMPLES_ASSETS_DIR in
    // CMakeLists.txt). The sky sphere and the spheres are the same geosphere.
    const MEDIA_DIR = "media/fragment_shading_rate_dynamic/";
    const GEOSPHERE_PATH = MEDIA_DIR + "geosphere.gltf";
    const SKYSPHERE_TEXTURE_PATH = MEDIA_DIR + "skysphere_rgba.dds";

    // Nri_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;

    // struct UBO { float4x4 projection, modelview, skybox_modelview; float modelscale; }, padded, as
    // f32 offsets; a queued frame's in a 256-byte slice of the constant buffer.
    const UBO_PROJECTION = 0;
    const UBO_MODELVIEW = 16;
    const UBO_SKYBOX_MODELVIEW = 32;
    const UBO_MODELSCALE = 48;
    const UBO_FLOATS = 52;
    const UBO_STRIDE = 256;
    const MODEL_SCALE = 0.05;
    // The push constants (root constants at b1): float4 offset; float4 color; int object_type.
    const PUSH_FLOATS = 9;
    const PUSH_SIZE = PUSH_FLOATS * 4;
    const OBJECT_SKYSPHERE = 0;
    const OBJECT_SPHERE = 1;

    // The three spheres' offsets and colors.
    const MESH_OFFSETS = [-2.5, 0.0, 0.0, 0.0, 0.0, 0.0, 2.5, 0.0, 0.0];
    const MESH_COLORS = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];

    // The sample's look-at camera at (0, 0, -6) turned 180 degrees around y, a 60 degree vertical
    // field of view, depth reversed (near 256, far 0.1, as the sample passes them).
    const CAMERA_POSITION = [0.0, 0.0, -6.0];
    const CAMERA_ROTATION = [0.0, 180.0, 0.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;

    // What the sample keeps of the validation layer's messages: from the shader's text on.
    const PRINTF_PREFIX = "Position";

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // The sample's camera (the framework's vkb::Camera, look-at type), with ApiVulkanSample's mouse
    // controls: the left button turns it, the right one zooms, the middle one pans (as the Donut
    // example's SampleCamera).
    class SampleCamera {
        rotation: number[] = [CAMERA_ROTATION[0], CAMERA_ROTATION[1], CAMERA_ROTATION[2]];
        position: number[] = [CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]];
        private mouseX: number = 0.0;
        private mouseY: number = 0.0;
        private buttons: boolean[] = [false, false, false];

        // vkb::Camera::update_view_matrix: rotations around x, y, z; a look-at camera's view is
        // translate(position) * rotation.
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

        // ApiVulkanSample's mouse wheel: zoom.
        mouseScroll(yoffset: number) {
            this.position[2] += yoffset * 0.005;
        }
    }

    // What a frame in flight records into: its command buffer, its UBO slice's view and its
    // descriptor set (the UBO's slice, the sky sphere's texture and sampler).
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public constantBufferView: NriDescriptorHandle | null, public set: NriDescriptorSetHandle | null) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // -test: checks the shader's output over the frames, as the Donut example does: printf's
    // messages arrived, and every one is the shader's text.
    function checkOutput(output: string[]) {
        console.log(`${output.length} printf messages`);
        for (let i = 0; i < output.length && i < 8; i++) {
            console.log(output[i]);
        }
        if (output.length == 0) {
            return "no printf output arrived";
        }
        for (const line of output) {
            if (line.indexOf(PRINTF_PREFIX) != 0) {
                return `unexpected message: ${line}`;
            }
        }
        return "";
    }

    // Port of Vulkan-Samples' shader_debugprintf (as examples/shader_debugprintf.ts ports it) to NRI:
    // a sky sphere and three Phong-lit spheres, the vertex shader printing (printf) the view space
    // position of each draw's vertex 0. The validation layer, its printf setting on
    // (Nri_UseShaderPrintf), instruments the shaders to write the values to a buffer, reads it back
    // once the GPU has finished, and delivers the formatted text as messages, which the overlay
    // shows (Nri_UpdateShaderPrintfOutput). Vulkan only (D3D shaders have no printf). Drawn into the
    // sRGB swap chain view, as the Donut example draws into its back buffer; the overlay in a pass of
    // its own (NRIFramework's ImGui pipeline has no depth).
    class ShaderDebugPrintf {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private layout: NriPipelineLayoutHandle | null = null;
        private skyspherePipeline: NriPipelineHandle | null = null;
        private spherePipeline: NriPipelineHandle | null = null;
        private geosphere: NriGltfMeshHandle | null = null;
        private texture: NriTextureHandle | null = null;
        private textureView: NriDescriptorHandle | null = null;
        private sampler: NriDescriptorHandle | null = null;
        private depthTexture: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private constantBuffer: NriBufferHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;
        // Set by initialize when the example can't run ("" otherwise); notVulkan: another API asked.
        private unsupportedReason: string = "";
        private notVulkan: boolean = false;

        private camera: SampleCamera = new SampleCamera();
        private buttons: boolean[] = [false, false, false];

        // The sample's setting (-nosky), from its overlay; -noUI: no overlay (as the Donut example).
        displaySkysphere: boolean = true;
        noUI: boolean = false;

        // The shader's text from the messages the last frame took (the sample's debug_output); in
        // test mode, every frame's.
        private output: string[] = [];
        private allOutput: string[] = [];

        // Upload buffers: the UBO, the push constants.
        private ubo: f32[] = [];
        private push: f32[] = [];

        // -test: the last frame is read back into readbackBuffer (for -testOutput), rows rowPitch
        // bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
            }
            for (let i = 0; i < PUSH_FLOATS; i++) {
                this.push.push(0.0);
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
            if (this.notVulkan) {
                // printf in shaders is the Vulkan validation layer's (the Donut example's exit code).
                console.log("The Shader debugprintf example can only run on Vulkan API.");
                result = 1;
            } else if (this.unsupportedReason != "") {
                const test = Nri_IsTest(this.sample) != 0;
                console.log(test ? `Test SKIPPED: ${this.unsupportedReason}` : this.unsupportedReason);
                result = test ? TEST_SKIPPED : 1;
            } else if (result == 0 && this.test) {
                // The last frames' output, which the layer delivers once they're finished.
                const device = this.device;
                if (device) {
                    Nri_DeviceWaitIdle(device);
                }
                this.takeOutput();
                this.readBack();
                const failure = checkOutput(this.allOutput);
                console.log(failure == "" ? "Test PASSED" : `Test FAILED: ${failure}`);
                result = failure == "" ? 0 : 1;
            }
            this.destroy();
            return result;
        }

        initialize(graphicsAPI: NriGraphicsAPI): int {
            if (graphicsAPI != NriGraphicsAPI.VK) {
                this.notVulkan = true;
                return 0;
            }
            const device = Nri_CreateDevice(this.sample, graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri_GetGraphicsAPIString(graphicsAPI)} (${Nri_GetAdapterName(device)})`);
            if (Nri_HasShaderPrintf() == 0) {
                this.unsupportedReason = "Shader printf needs the Vulkan validation layer (VK_LAYER_KHRONOS_validation, from the Vulkan SDK).";
                return 0;
            }

            this.queue = Nri_GetGraphicsQueue(device);
            this.frameFence = Nri_CreateFence(device, 0);
            this.width = Nri_GetOutputWidth(this.sample);
            this.height = Nri_GetOutputHeight(this.sample);
            this.test = Nri_IsTest(this.sample) != 0;

            // Swap chain: rendered through sRGB views, as the Donut example's sRGB back buffer.
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

            // The model and the texture, as sRGB (as the framework loads KTX 1 color textures).
            this.geosphere = Nri_LoadGltfMesh(device, this.queue, GEOSPHERE_PATH);
            const texture = Nri_LoadDdsTexture(device, this.queue, SKYSPHERE_TEXTURE_PATH, 1);
            this.texture = texture;
            if (!this.geosphere || !texture) {
                console.log("Cannot load the model and texture: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            const textureView = Nri_CreateTextureView(texture, NriFormat.RGBA8_SRGB);
            this.textureView = textureView;
            // ApiVulkanSample::load_texture's sampler: linear, repeating, anisotropic at the device's
            // most.
            const sampler = Nri_CreateSamplerWithMipFilter(device, NriFilter.Linear, NriFilter.Linear, NriAddressMode.Repeat,
                Nri_GetMaxSamplerAnisotropy(device));
            this.sampler = sampler;

            // The layout: the descriptor set (the UBO at b0, the texture and sampler at t0 and s0)
            // and the push constants (b1: root constants).
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRootConstants(layoutDesc, 1, PUSH_SIZE, NriStage.VertexPixel);
            this.layout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            const layout = this.layout;
            if (!layout || !sampler) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The sample's pipelines: the sky sphere with back faces culled, not depth tested; the
            // spheres with front faces culled, depth tested (greater: reversed) and written;
            // counter-clockwise front faces.
            const shaders = "shaders/shader_debugprintf/spirv/shader_debugprintf";
            this.skyspherePipeline = this.createPipeline(device, layout, shaders, false);
            this.spherePipeline = this.createPipeline(device, layout, shaders, true);
            if (!this.skyspherePipeline || !this.spherePipeline) {
                console.log("Cannot load the shader debugprintf shaders");
                return 0;
            }

            // The UBO, a queued frame's each; the depth buffer.
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * UBO_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const depthTexture = Nri_CreateDepthTexture(device, this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!constantBuffer || !depthTexture) {
                console.log("Cannot create the buffers and the depth buffer");
                return 0;
            }
            this.depthAttachment = Nri_CreateDepthAttachmentView(depthTexture, NriFormat.D32_SFLOAT);

            // A descriptor set per queued frame.
            const descriptorPool = Nri_CreateDescriptorPool(device, queuedFrameNum, queuedFrameNum, queuedFrameNum, queuedFrameNum, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!descriptorPool) {
                console.log("Cannot create the descriptor pool");
                return 0;
            }
            for (let q = 0; q < queuedFrameNum; q++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const constantBufferView = Nri_CreateConstantBufferView(constantBuffer, q * UBO_STRIDE, UBO_STRIDE);
                const set = Nri_AllocateDescriptorSet(descriptorPool, layout, 0, 0);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), constantBufferView, set));
                if (!constantBufferView || !set) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(set, 0, 0, constantBufferView);
                Nri_UpdateDescriptor(set, 1, 0, textureView);
                Nri_UpdateDescriptor(set, 2, 0, sampler);
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

        // A pipeline of scene_vs and scene_ps: the sky sphere's (sphere false) or the spheres'.
        createPipeline(device: NriDeviceHandle, pipelineLayout: NriPipelineLayoutHandle, shaders: string, sphere: boolean) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_scene_vs.bin`, "scene_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_scene_ps.bin`, "scene_ps") != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescAddVertexAttribute(desc, "NORMAL", NriFormat.RGB32_SFLOAT, 12);
            Nri_PipelineDescAddVertexAttribute(desc, "TEXCOORD", NriFormat.RG32_SFLOAT, 24);
            Nri_PipelineDescSetCullMode(desc, sphere ? NriCullMode.Front : NriCullMode.Back);
            Nri_PipelineDescSetFrontCounterClockwise(desc, 1);
            Nri_PipelineDescSetColor(desc, this.viewFormat, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, sphere ? NriCompareOp.Greater : NriCompareOp.None, sphere ? 1 : 0, 0);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, pipelineLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // Waits for the frame that last used this frame's command allocator (and its UBO).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The messages the layer has delivered since the last call, cut to the shader's text as the
        // sample's debug_utils_message_callback does.
        takeOutput() {
            const count = Nri_UpdateShaderPrintfOutput();
            this.output = [];
            for (let i = 0; i < count; i++) {
                const message = Nri_GetShaderPrintfLine(i);
                const start = message.indexOf(PRINTF_PREFIX);
                const text = start >= 0 ? message.substring(start, message.length) : message.substring(0, message.length);
                this.output.push(text);
                if (this.test) {
                    this.allOutput.push(text);
                }
            }
        }

        // The camera's mouse input (ApiVulkanSample's), unless the overlay has the mouse; none in
        // test mode.
        handleInput() {
            if (this.test) {
                return;
            }
            const overlay = this.imgui && Nri_ImguiWantsMouse() != 0;
            for (let button = 0; button < 3; button++) {
                const pressed = Nri_IsButtonPressed(this.sample, button) != 0;
                if (pressed != this.buttons[button]) {
                    if (!pressed || !overlay) {
                        this.camera.mouseButton(button, pressed);
                        this.buttons[button] = pressed;
                    }
                }
            }
            if (!overlay) {
                this.camera.mouseMove(Nri_GetMouseX(this.sample), Nri_GetMouseY(this.sample));
                this.camera.mouseScroll(Nri_GetMouseWheel(this.sample));
            }
        }

        // The sample's overlay: its setting and the shader's output of the last frame.
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPos(10.0, 10.0);
            Nri_ImguiBegin("Shader debugprintf", 1);
            if (Nri_ImguiCollapsingHeader("Settings", 1) != 0) {
                this.displaySkysphere = Nri_ImguiCheckbox("skysphere", this.displaySkysphere ? 1 : 0) != 0;
            }
            if (Nri_ImguiCollapsingHeader("Debug output", 1) != 0) {
                for (const line of this.output) {
                    Nri_ImguiText(line);
                }
            }
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        // The sample's update_uniform_buffers: its projection (clip y negated, as the Donut example
        // gives it), the view for the model view and the sky sphere's, into this frame's slice.
        updateConstants(constantBuffer: NriBufferHandle, offset: int) {
            const projection = perspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR);
            const view = this.camera.view();
            const u = this.ubo;
            for (let i = 0; i < 16; i++) {
                u[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                u[UBO_MODELVIEW + i] = view[i];
                u[UBO_SKYBOX_MODELVIEW + i] = view[i];
            }
            u[UBO_MODELSCALE] = MODEL_SCALE;
            Nri_WriteBuffer(constantBuffer, offset, Ref(u[0]), UBO_FLOATS * 4);
        }

        // The push constants: an offset, a color and the object's kind.
        setPush(commandBuffer: NriCommandBufferHandle, sphere: int, objectType: int) {
            for (let k = 0; k < 3; k++) {
                this.push[k] = sphere >= 0 ? MESH_OFFSETS[sphere * 3 + k] : 0.0;
                this.push[4 + k] = sphere >= 0 ? MESH_COLORS[sphere * 3 + k] : 0.0;
            }
            this.push[3] = 0.0;
            this.push[7] = 0.0;
            Nri_StoreInt32(Ref(this.push[8]), objectType);
            Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.push[0]), PUSH_SIZE);
        }

        // The sample's build_command_buffer: color and depth cleared to 0, the sky sphere (if shown),
        // the three spheres.
        recordScene(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame, queuedFrameIndex: int,
            swapChainTexture: SwapChainTexture) {
            const descriptorPool = this.descriptorPool;
            const constantBuffer = this.constantBuffer;
            const depthAttachment = this.depthAttachment;
            const layout = this.layout;
            const geosphere = this.geosphere;
            const skyspherePipeline = this.skyspherePipeline;
            const spherePipeline = this.spherePipeline;
            const set = queuedFrame.set;
            if (!descriptorPool || !constantBuffer || !depthAttachment || !layout || !geosphere || !skyspherePipeline
                || !spherePipeline || !set) {
                return;
            }
            this.updateConstants(constantBuffer, queuedFrameIndex * UBO_STRIDE);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdBeginRenderingWithDepth(commandBuffer, swapChainTexture.colorAttachment, depthAttachment);
            Nri_CmdClearColorAttachment(commandBuffer, 0, 0.0, 0.0, 0.0, 0.0);
            Nri_CmdClearDepth(commandBuffer, 0.0);
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, layout);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, Nri_GetGltfMeshVertexBuffer(geosphere), 0, VERTEX_SIZE);
            Nri_CmdSetIndexBuffer(commandBuffer, Nri_GetGltfMeshIndexBuffer(geosphere), 0, NriIndexType.UInt32);
            const indexCount = Nri_GetGltfMeshIndexCount(geosphere);

            if (this.displaySkysphere) {
                Nri_CmdSetPipeline(commandBuffer, skyspherePipeline);
                Nri_CmdSetDescriptorSet(commandBuffer, 0, set);
                this.setPush(commandBuffer, -1, OBJECT_SKYSPHERE);
                Nri_CmdDrawIndexed(commandBuffer, indexCount, 1, 0, 0, 0);
            }

            Nri_CmdSetPipeline(commandBuffer, spherePipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, set);
            for (let j = 0; j < 3; j++) {
                this.setPush(commandBuffer, j, OBJECT_SPHERE);
                Nri_CmdDrawIndexed(commandBuffer, indexCount, 1, 0, 0, 0);
            }
            Nri_CmdEndRendering(commandBuffer);
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            // The messages delivered so far (the Donut example's onAnimate), then the overlay showing
            // them.
            this.takeOutput();
            if (this.imgui) {
                this.buildUI();
            }
            this.handleInput();

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: the scene, then the overlay over it in a pass of its own.
                Nri_BeginCommandBuffer(commandBuffer);
                if (this.imgui) {
                    Nri_CmdCopyImguiData(this.sample, commandBuffer);
                }
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                this.recordScene(commandBuffer, queuedFrame, queuedFrameIndex, swapChainTexture);
                if (this.imgui) {
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

        // The last frame read back (Nri_ReadBufferRGBA8 saves it for -testOutput); its pixels are
        // not checked (the Donut example checks the printf output only).
        readBack() {
            const device = this.device;
            const readbackBuffer = this.readbackBuffer;
            if (!device || !readbackBuffer) {
                return;
            }
            Nri_DeviceWaitIdle(device);
            const pixels: int[] = [];
            for (let i = 0; i < this.width * this.height; i++) {
                pixels.push(0);
            }
            Nri_ReadBufferRGBA8(readbackBuffer, this.rowPitch, this.width, this.height, this.readbackFormat, Ref(pixels[0]), pixels.length);
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
                    this.destroyDescriptor(queuedFrame.constantBufferView);
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
                this.destroyDescriptor(this.textureView);
                this.destroyDescriptor(this.sampler);
                this.destroyDescriptor(this.depthAttachment);
                this.destroyTexture(this.texture);
                this.destroyTexture(this.depthTexture);
                const geosphere = this.geosphere;
                if (geosphere) {
                    Nri_DestroyGltfMesh(geosphere);
                }
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.skyspherePipeline);
                this.destroyPipeline(this.spherePipeline);
                const layout = this.layout;
                if (layout) {
                    Nri_DestroyPipelineLayout(layout);
                }
                if (this.queuedFrames.length > 0) {
                    Nri_DestroyFence(this.frameFence);
                    Nri_DestroySwapChain(this.swapChain);
                }
                Nri_DestroyDevice(device);
            }
            Nri_DestroySample(this.sample);
        }

        destroyDescriptor(descriptor: NriDescriptorHandle | null) {
            if (descriptor) {
                Nri_DestroyDescriptor(descriptor);
            }
        }

        destroyTexture(texture: NriTextureHandle | null) {
            if (texture) {
                Nri_DestroyTexture(texture);
            }
        }

        destroyBuffer(buffer: NriBufferHandle | null) {
            if (buffer) {
                Nri_DestroyBuffer(buffer);
            }
        }

        destroyPipeline(pipeline: NriPipelineHandle | null) {
            if (pipeline) {
                Nri_DestroyPipeline(pipeline);
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const debugPrintf = new ShaderDebugPrintf(sample);
        // -nosky: without the sky sphere; -noUI: no overlay.
        Nri_AddExampleOption(sample, "-nosky");
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        // printf in shaders: the Vulkan validation layer's, with its printf setting.
        Nri_UseShaderPrintf(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-nosky") {
                debugPrintf.displaySkysphere = false;
            } else if (arg == "-noUI") {
                debugPrintf.noUI = true;
            }
        }
        return debugPrintf.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return ShaderDebugPrintfNri.main(argc, argv);
}

/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { identity, multiply, rotate, radians, perspective } from "../../core/matrix";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriGltfMesh, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

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

    // NriDevice.loadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
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

    // A frame in flight's own data: its UBO slice's view and its
    // descriptor set (the UBO's slice, the sky sphere's texture and sampler).
    class QueuedFrame {
        constructor(public constantBufferView: NriDescriptor | null, public set: NriDescriptorSet | null) {
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
    // (NriSample.useShaderPrintf), instruments the shaders to write the values to a buffer, reads it back
    // once the GPU has finished, and delivers the formatted text as messages, which the overlay
    // shows (Nri.updateShaderPrintfOutput). Vulkan only (D3D shaders have no printf). Drawn into the
    // sRGB swap chain view, as the Donut example draws into its back buffer; the overlay in a pass of
    // its own (NRIFramework's ImGui pipeline has no depth).
    class ShaderDebugPrintf {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private layout: NriPipelineLayout | null = null;
        private skyspherePipeline: NriPipeline | null = null;
        private spherePipeline: NriPipeline | null = null;
        private geosphere: NriGltfMesh | null = null;
        private texture: NriTexture | null = null;
        private textureView: NriDescriptor | null = null;
        private sampler: NriDescriptor | null = null;
        private depthTexture: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
        private constantBuffer: NriBuffer | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private imgui: boolean = false;
        // The swap chain's size: the window's when it was (re)created.
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views'.
        private swapChainFormat: NriFormat = 0;
        private swapChainViewFormat: NriFormat = 0;
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
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
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
            this.sample.setInitializeCallback(initialize);
            this.sample.setLatencySleepCallback(latencySleep);
            this.sample.setRenderFrameCallback(renderFrame);

            // On a wrapper of its own: the callbacks Nri_RunSample runs may overwrite this.sample.
            let result = new NriSample(this.sample.handle).run(argc, argv, WINDOW_TITLE, TEST_FRAMES);
            if (this.notVulkan) {
                // printf in shaders is the Vulkan validation layer's (the Donut example's exit code).
                console.log("The Shader debugprintf example can only run on Vulkan API.");
                result = 1;
            } else if (this.unsupportedReason != "") {
                const test = this.sample.isTest() != 0;
                console.log(test ? `Test SKIPPED: ${this.unsupportedReason}` : this.unsupportedReason);
                result = test ? TEST_SKIPPED : 1;
            } else if (result == 0 && this.test) {
                // The last frames' output, which the layer delivers once they're finished.
                const device = this.device;
                if (device) {
                    device.waitIdle();
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
            const device = this.sample.createDevice(graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri.getGraphicsAPIString(graphicsAPI)} (${device.getAdapterName()})`);
            if (Nri.hasShaderPrintf() == 0) {
                this.unsupportedReason = "Shader printf needs the Vulkan validation layer (VK_LAYER_KHRONOS_validation, from the Vulkan SDK).";
                return 0;
            }

            this.queue = device.getGraphicsQueue();
            this.test = this.sample.isTest() != 0;

            // Swap chain: rendered through sRGB views, as the Donut example's sRGB back buffer.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.swapChainViewFormat;
            this.viewFormat = viewFormat;

            // The model and the texture, as sRGB (as the framework loads KTX 1 color textures).
            this.geosphere = device.loadGltfMesh(this.queue, GEOSPHERE_PATH);
            const texture = device.loadDdsTexture(this.queue, SKYSPHERE_TEXTURE_PATH, 1);
            this.texture = texture;
            if (!this.geosphere || !texture) {
                console.log("Cannot load the model and texture: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            const textureView = texture.createView(NriFormat.RGBA8_SRGB);
            this.textureView = textureView;
            // ApiVulkanSample::load_texture's sampler: linear, repeating, anisotropic at the device's
            // most.
            const sampler = device.createSamplerWithMipFilter(NriFilter.Linear, NriFilter.Linear, NriAddressMode.Repeat,
                device.getMaxSamplerAnisotropy());
            this.sampler = sampler;

            // The layout: the descriptor set (the UBO at b0, the texture and sampler at t0 and s0)
            // and the push constants (b1: root constants).
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.addRootConstants(1, PUSH_SIZE, NriStage.VertexPixel);
            this.layout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
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
            const constantBuffer = device.createHostBuffer(queuedFrameNum * UBO_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const depthCreated = this.createDepth(device);
            if (!constantBuffer || !depthCreated) {
                console.log("Cannot create the buffers and the depth buffer");
                return 0;
            }

            // A descriptor set per queued frame.
            const descriptorPool = device.createDescriptorPool(queuedFrameNum, queuedFrameNum, queuedFrameNum, queuedFrameNum, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!descriptorPool) {
                console.log("Cannot create the descriptor pool");
                return 0;
            }
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let q = 0; q < queuedFrameNum; q++) {
                const constantBufferView = constantBuffer.createConstantView(q * UBO_STRIDE, UBO_STRIDE);
                const set = descriptorPool.allocateDescriptorSet(layout, 0, 0);
                this.queuedFrames.push(new QueuedFrame(constantBufferView, set));
                if (!constantBufferView || !set) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                set.updateDescriptor(0, 0, constantBufferView);
                set.updateDescriptor(1, 0, textureView);
                set.updateDescriptor(2, 0, sampler);
            }

            // The sample's overlay.
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

        // A pipeline of scene_vs and scene_ps: the sky sphere's (sphere false) or the spheres'.
        createPipeline(device: NriDevice, pipelineLayout: NriPipelineLayout, shaders: string, sphere: boolean) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_scene_vs.bin`, "scene_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_scene_ps.bin`, "scene_ps") != 0;
            }
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            desc.addVertexAttribute("NORMAL", NriFormat.RGB32_SFLOAT, 12);
            desc.addVertexAttribute("TEXCOORD", NriFormat.RG32_SFLOAT, 24);
            desc.setCullMode(sphere ? NriCullMode.Front : NriCullMode.Back);
            desc.setFrontCounterClockwise(1);
            desc.setColor(this.viewFormat, NriColorWrite.RGBA);
            desc.setDepth(NriFormat.D32_SFLOAT, sphere ? NriCompareOp.Greater : NriCompareOp.None, sphere ? 1 : 0, 0);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(pipelineLayout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        // Waits for the frame that last used this frame's command allocator (and its UBO).
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The messages the layer has delivered since the last call, cut to the shader's text as the
        // sample's debug_utils_message_callback does.
        takeOutput() {
            const count = Nri.updateShaderPrintfOutput();
            this.output = [];
            for (let i = 0; i < count; i++) {
                const message = Nri.getShaderPrintfLine(i);
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
            const overlay = this.imgui && NriImgui.wantsMouse() != 0;
            for (let button = 0; button < 3; button++) {
                const pressed = this.sample.isButtonPressed(button) != 0;
                if (pressed != this.buttons[button]) {
                    if (!pressed || !overlay) {
                        this.camera.mouseButton(button, pressed);
                        this.buttons[button] = pressed;
                    }
                }
            }
            if (!overlay) {
                this.camera.mouseMove(this.sample.getMouseX(), this.sample.getMouseY());
                this.camera.mouseScroll(this.sample.getMouseWheel());
            }
        }

        // The sample's overlay: its setting and the shader's output of the last frame.
        buildUI() {
            this.sample.imguiNewFrame();
            NriImgui.setNextWindowPos(10.0, 10.0);
            NriImgui.begin("Shader debugprintf", 1);
            if (NriImgui.collapsingHeader("Settings", 1) != 0) {
                this.displaySkysphere = NriImgui.checkbox("skysphere", this.displaySkysphere ? 1 : 0) != 0;
            }
            if (NriImgui.collapsingHeader("Debug output", 1) != 0) {
                for (const line of this.output) {
                    NriImgui.text(line);
                }
            }
            NriImgui.end();
            this.sample.imguiRender();
        }

        // The sample's update_uniform_buffers: its projection (clip y negated, as the Donut example
        // gives it), the view for the model view and the sky sphere's, into this frame's slice.
        updateConstants(constantBuffer: NriBuffer, offset: int) {
            const projection = perspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR);
            const view = this.camera.view();
            const u = this.ubo;
            for (let i = 0; i < 16; i++) {
                u[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                u[UBO_MODELVIEW + i] = view[i];
                u[UBO_SKYBOX_MODELVIEW + i] = view[i];
            }
            u[UBO_MODELSCALE] = MODEL_SCALE;
            constantBuffer.write(offset, Ref(u[0]), UBO_FLOATS * 4);
        }

        // The push constants: an offset, a color and the object's kind.
        setPush(commandBuffer: NriCommandBuffer, sphere: int, objectType: int) {
            for (let k = 0; k < 3; k++) {
                this.push[k] = sphere >= 0 ? MESH_OFFSETS[sphere * 3 + k] : 0.0;
                this.push[4 + k] = sphere >= 0 ? MESH_COLORS[sphere * 3 + k] : 0.0;
            }
            this.push[3] = 0.0;
            this.push[7] = 0.0;
            Nri.storeInt32(Ref(this.push[8]), objectType);
            commandBuffer.setRootConstants(0, Ref(this.push[0]), PUSH_SIZE);
        }

        // The sample's build_command_buffer: color and depth cleared to 0, the sky sphere (if shown),
        // the three spheres.
        recordScene(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame, queuedFrameIndex: int,
            index: int) {
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
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.beginRenderingWithDepth(this.swapChain.colorAttachment(index), depthAttachment);
            commandBuffer.clearColorAttachment(0, 0.0, 0.0, 0.0, 0.0);
            commandBuffer.clearDepth(0.0);
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(layout);
            commandBuffer.setVertexBuffer(0, geosphere.getVertexBuffer(), 0, VERTEX_SIZE);
            commandBuffer.setIndexBuffer(geosphere.getIndexBuffer(), 0, NriIndexType.UInt32);
            const indexCount = geosphere.getIndexCount();

            if (this.displaySkysphere) {
                commandBuffer.setPipeline(skyspherePipeline);
                commandBuffer.setDescriptorSet(0, set);
                this.setPush(commandBuffer, -1, OBJECT_SKYSPHERE);
                commandBuffer.drawIndexed(indexCount, 1, 0, 0, 0);
            }

            commandBuffer.setPipeline(spherePipeline);
            commandBuffer.setDescriptorSet(0, set);
            for (let j = 0; j < 3; j++) {
                this.setPush(commandBuffer, j, OBJECT_SPHERE);
                commandBuffer.drawIndexed(indexCount, 1, 0, 0, 0);
            }
            commandBuffer.endRendering();
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
        }

        // The depth buffer at the swap chain's size; false on failure.
        createDepth(device: NriDevice): boolean {
            const depthTexture = device.createDepthTexture(this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
                return false;
            }
            this.depthAttachment = depthTexture.createDepthAttachmentView(NriFormat.D32_SFLOAT);
            return true;
        }

        destroyDepth() {
            const depthAttachment = this.depthAttachment;
            if (depthAttachment) {
                depthAttachment.destroy();
            }
            this.depthAttachment = null;
            const depthTexture = this.depthTexture;
            if (depthTexture) {
                depthTexture.destroy();
            }
            this.depthTexture = null;
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain (and what has the window's
        // size) made again at its size, once the GPU is done with the old ones.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (!this.swapChain.resized()) {
                return;
            }
            device.waitIdle();
            this.destroyDepth();
            this.swapChain.recreate();
            this.sizeToSwapChain();
            this.createDepth(device);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
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
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: the scene, then the overlay over it in a pass of its own.
                commandBuffer.begin();
                if (this.imgui) {
                    this.sample.copyImguiData(commandBuffer);
                }
                commandBuffer.textureBarrier(this.swapChain.texture(index), NriTextureState.Undefined, NriTextureState.ColorAttachment);
                this.recordScene(commandBuffer, queuedFrame, queuedFrameIndex, index);
                if (this.imgui) {
                    commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                    this.sample.drawImgui(commandBuffer, this.viewFormat);
                    commandBuffer.endRendering();
                }

                // The test's last frame: read back
                let presentFrom = NriTextureState.ColorAttachment;
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    if (frameIndex == TEST_FRAMES - 1) {
                        commandBuffer.textureBarrier(this.swapChain.texture(index), NriTextureState.ColorAttachment, NriTextureState.CopySource);
                        commandBuffer.readbackTextureToBuffer(readbackBuffer, this.rowPitch, this.swapChain.texture(index), this.width, this.height);
                        presentFrom = NriTextureState.CopySource;
                    }
                }
                commandBuffer.textureBarrier(this.swapChain.texture(index), presentFrom, NriTextureState.Present);
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

        // The last frame read back (NriBuffer.readRGBA8 saves it for -testOutput); its pixels are
        // not checked (the Donut example checks the printf output only).
        readBack() {
            const device = this.device;
            const readbackBuffer = this.readbackBuffer;
            if (!device || !readbackBuffer) {
                return;
            }
            device.waitIdle();
            const pixels: int[] = [];
            for (let i = 0; i < this.width * this.height; i++) {
                pixels.push(0);
            }
            readbackBuffer.readRGBA8(this.rowPitch, this.width, this.height, this.readbackFormat, Ref(pixels[0]), pixels.length);
        }

        destroy() {
            const device = this.device;
            if (device) {
                device.waitIdle();
                if (this.imgui) {
                    this.sample.destroyImgui();
                }
                for (const queuedFrame of this.queuedFrames) {
                    this.destroyDescriptor(queuedFrame.constantBufferView);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                this.destroyDescriptor(this.textureView);
                this.destroyDescriptor(this.sampler);
                this.destroyDepth();
                this.destroyTexture(this.texture);
                const geosphere = this.geosphere;
                if (geosphere) {
                    geosphere.destroy();
                }
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.skyspherePipeline);
                this.destroyPipeline(this.spherePipeline);
                const layout = this.layout;
                if (layout) {
                    layout.destroy();
                }
                if (this.queuedFrames.length > 0) {
                    this.frames.destroy();
                    this.swapChain.destroy();
                }
                device.destroy();
            }
            this.sample.destroy();
        }

        destroyDescriptor(descriptor: NriDescriptor | null) {
            if (descriptor) {
                descriptor.destroy();
            }
        }

        destroyTexture(texture: NriTexture | null) {
            if (texture) {
                texture.destroy();
            }
        }

        destroyBuffer(buffer: NriBuffer | null) {
            if (buffer) {
                buffer.destroy();
            }
        }

        destroyPipeline(pipeline: NriPipeline | null) {
            if (pipeline) {
                pipeline.destroy();
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const debugPrintf = new ShaderDebugPrintf(sample);
        // -nosky: without the sky sphere; -noUI: no overlay.
        sample.addExampleOption("-nosky");
        sample.addExampleOption("-noUI");
        sample.useImgui();
        // printf in shaders: the Vulkan validation layer's, with its printf setting.
        sample.useShaderPrintf();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
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

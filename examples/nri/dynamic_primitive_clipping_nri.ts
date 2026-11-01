/// <reference path="../../core/nri/nri_interop.d.ts" />
import { identity, rotate, radians, perspective } from "../../core/matrix";
import { comboItems } from "../../core/text_format";
import { LookAtCamera } from "../../core/vulkan_samples_camera";

namespace DynamicPrimitiveClippingNri {
    // dynamic_primitive_clipping, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework
    // instead of Donut and NVRHI: the same shaders (dynamic_primitive_clipping.hlsl's) and models
    // (read as Donut's loadGltfMesh reads them), through the NRI calls core/nri/nri_interop.d.ts
    // binds, with NRIFramework's ImGui for the sample's settings. This example creates everything it
    // runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Dynamic Primitive Clipping";

    // The sample's models (Vulkan-Samples' assets, copied at build time; see
    // VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const MODEL_PATHS = ["media/dynamic_primitive_clipping/teapot.gltf", "media/dynamic_primitive_clipping/torusknot.gltf",
        "media/dynamic_primitive_clipping/geosphere.gltf"];
    const MODEL_NAMES = ["Teapot", "Torusknot", "Sphere"];
    const VISUALIZATION_NAMES = ["World space X", "World space Y", "Half-space in world space coordinates",
        "Half-space in clip space coordinates", "Clip space X", "Clip space Y", "Euclidean distance to center",
        "Manhattan distance to center", "Chebyshev distance to center"];

    // Nri_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;

    // The sample's camera: a look-at camera at (0, 0, -50) turned by (0, 180, 0) degrees, a 60
    // degree vertical field of view; the near plane far from the eye (30) to show depth clipping.
    const CAMERA_POSITION = [0.0, 0.0, -50.0];
    const CAMERA_ROTATION = [0.0, 180.0, 0.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 30.0;
    const Z_FAR = 256.0;

    // struct UBOVS { float4x4 projection, view, model; float4 colorTransformation; int2
    // sceneTransformation; float usePrimitiveClipping; }, padded; a draw's each in a 256-byte slice
    // of the constant buffer (D3D12 constant buffer views' alignment), two draws a queued frame.
    const UBO_PROJECTION = 0;
    const UBO_VIEW = 16;
    const UBO_MODEL = 32;
    const UBO_COLOR_TRANSFORMATION = 48;
    const UBO_SCENE_TRANSFORMATION = 52;
    const UBO_USE_PRIMITIVE_CLIPPING = 54;
    const UBO_FLOATS = 56;
    const UBO_STRIDE = 256;

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

    // -test: checks the last frame, read back, as the Donut example does. The corners are the gray
    // background; the striped teapot colors 15% to 35% of the frame (channels 61 or more apart).
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const background = 0x595959;
        const xs = [0, width - 1, 0, width - 1];
        const ys = [0, 0, height - 1, height - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[ys[k] * width + xs[k]] & 0xFFFFFF;
            if (p != background) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not 89, 89, 89`;
            }
        }
        let colored = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            const high = Math.max(r, Math.max(g, b));
            const low = Math.min(r, Math.min(g, b));
            if (high - low >= 61) {
                colored++;
            }
        }
        const total = width * height;
        const percent = 100.0 * colored / total;
        console.log(`Teapot: ${percent}% (${colored} of ${total} pixels)`);
        if (percent < 15.0 || percent > 35.0) {
            return `Teapot: ${percent}% of the pixels, not 15% to 35%`;
        }
        return "";
    }

    // Port of Vulkan-Samples' dynamic_primitive_clipping (as examples/dynamic_primitive_clipping.ts
    // ports it) to NRI: an object drawn twice with user clip distances (SV_ClipDistance), the second
    // time with them negated and its colors inverted, so that each draw shows what the other clips
    // away. The UI picks the function the vertex shader computes the clip distance with, and switches
    // clipping at the near and far planes: the sample's dynamic depth clip state
    // (VK_EXT_depth_clip_enable) is a pipeline of its own here, as in the Donut example.
    class DynamicPrimitiveClipping {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private pipelineLayout: NriPipelineLayoutHandle | null = null;
        // Without depth clipping, then with it.
        private pipelines: (NriPipelineHandle | null)[] = [];
        private models: NriGltfMeshHandle[] = [];
        private constantBuffer: NriBufferHandle | null = null;
        private constantBufferView: NriDescriptorHandle | null = null;
        private depthTexture: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;

        private camera: LookAtCamera = new LookAtCamera(CAMERA_POSITION, CAMERA_ROTATION);
        // The mouse buttons as the camera last saw them.
        private buttons: boolean[] = [false, false, false];
        // The teapot scaled by 10 and turned upside down (half a turn around x).
        private transforms: number[][] = [];

        // The sample's settings, from its UI and the options: -object <n>, -visualization <n>,
        // -noclipping, -depthclip, -only <1 or 2>; -noUI: no settings window.
        objectIndex: int = 0;
        usePrimitiveClipping: boolean = true;
        visualization: int = 0;
        drawObject: boolean[] = [true, true];
        useDepthClipping: boolean = false;
        noUI: boolean = false;

        // Upload buffer.
        private ubo: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            const teapot = rotate([10.0, 0.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 0.0, 1.0],
                radians(180.0), 1.0, 0.0, 0.0);
            this.transforms = [teapot, identity(), identity()];
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
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
            if (result == 0 && this.test) {
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

            // Queued frames
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator)));
            }

            // The models.
            for (const modelPath of MODEL_PATHS) {
                const model = Nri_LoadGltfMesh(device, this.queue, modelPath);
                if (!model) {
                    console.log("Cannot load the models: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                    return 0;
                }
                this.models.push(model);
            }

            // The layout: the UBO (b0), a root descriptor bound at each draw's slice.
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootDescriptor(layoutDesc, 0, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel);
            this.pipelineLayout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            const pipelineLayout = this.pipelineLayout;
            if (!pipelineLayout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The sample's pipeline: dynamic_primitive_clipping.hlsl's shaders, as compiled for the
            // Donut example; depth tested (less) and written, no culling, clockwise front faces;
            // without depth clipping, then with it.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : (graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv");
            const shaders = `shaders/dynamic_primitive_clipping/${folder}/dynamic_primitive_clipping`;
            for (let clip = 0; clip < 2; clip++) {
                const desc = Nri_CreatePipelineDesc();
                let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_main_vs.bin`, "main_vs") != 0;
                if (loaded) {
                    loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_main_ps.bin`, "main_ps") != 0;
                }
                Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
                Nri_PipelineDescAddVertexAttribute(desc, "NORMAL", NriFormat.RGB32_SFLOAT, 12);
                Nri_PipelineDescSetColor(desc, viewFormat, NriColorWrite.RGBA);
                Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.Less, 1, 0);
                Nri_PipelineDescSetDepthClip(desc, clip);
                let pipeline: NriPipelineHandle | null = null;
                if (loaded) {
                    pipeline = Nri_CreatePipelineFromDesc(device, pipelineLayout, desc);
                }
                Nri_DestroyPipelineDesc(desc);
                if (!pipeline) {
                    console.log("Cannot load the dynamic primitive clipping shaders");
                    return 0;
                }
                this.pipelines.push(pipeline);
            }

            // The UBOs, two draws a queued frame; the depth buffer.
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * 2 * UBO_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const depthTexture = Nri_CreateDepthTexture(device, this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!constantBuffer || !depthTexture) {
                console.log("Cannot create the constant and depth buffers");
                return 0;
            }
            this.constantBufferView = Nri_CreateConstantBufferView(constantBuffer, 0, UBO_STRIDE);
            this.depthAttachment = Nri_CreateDepthAttachmentView(depthTexture, NriFormat.D32_SFLOAT);

            // The sample's settings.
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

        // Waits for the frame that last used this frame's command allocator (and its UBOs).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The camera's mouse handling (ApiVulkanSample's), unless the settings window has the
        // mouse: the buttons' changes, then the cursor's position.
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
            this.camera.mouseMove(Nri_GetMouseX(this.sample), Nri_GetMouseY(this.sample));
        }

        // The sample's settings.
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPos(10.0, 10.0);
            Nri_ImguiBegin("Options", 1);
            if (Nri_ImguiCollapsingHeader("Settings", 1) != 0) {
                this.objectIndex = Nri_ImguiCombo("Object type", this.objectIndex, comboItems(MODEL_NAMES));
                this.usePrimitiveClipping = Nri_ImguiCheckbox("Use primitive clipping", this.usePrimitiveClipping ? 1 : 0) != 0;
                this.visualization = Nri_ImguiCombo("Visualization", this.visualization, comboItems(VISUALIZATION_NAMES));
                this.drawObject[0] = Nri_ImguiCheckbox("Draw object 1", this.drawObject[0] ? 1 : 0) != 0;
                this.drawObject[1] = Nri_ImguiCheckbox("Draw object 2", this.drawObject[1] ? 1 : 0) != 0;
                this.useDepthClipping = Nri_ImguiCheckbox("Use depth clipping", this.useDepthClipping ? 1 : 0) != 0;
            }
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        // The sample's update_uniform_buffers for one draw (at offset in the constant buffer): its
        // color transformation and clip distance sign.
        writeUniforms(constantBuffer: NriBufferHandle, offset: int, projection: number[], view: number[], colorScale: number,
            colorOffset: number, sign: int) {
            const u = this.ubo;
            const model = this.transforms[this.objectIndex];
            for (let i = 0; i < 16; i++) {
                u[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                u[UBO_VIEW + i] = view[i];
                u[UBO_MODEL + i] = model[i];
            }
            u[UBO_COLOR_TRANSFORMATION] = colorScale;
            u[UBO_COLOR_TRANSFORMATION + 1] = colorOffset;
            u[UBO_COLOR_TRANSFORMATION + 2] = 0.0;
            u[UBO_COLOR_TRANSFORMATION + 3] = 0.0;
            Nri_StoreInt32(Ref(u[UBO_SCENE_TRANSFORMATION]), this.visualization);
            Nri_StoreInt32(Ref(u[UBO_SCENE_TRANSFORMATION + 1]), sign);
            u[UBO_USE_PRIMITIVE_CLIPPING] = this.usePrimitiveClipping ? 1.0 : -1.0;
            Nri_WriteBuffer(constantBuffer, offset, Ref(u[0]), UBO_FLOATS * 4);
        }

        // The object, then (with primitive clipping) the same object with the clip distances negated
        // (between Nri_CmdBeginRenderingWithDepth and Nri_CmdEndRendering); this queued frame's UBOs
        // from frameOffset.
        recordDraw(commandBuffer: NriCommandBufferHandle, frameOffset: int) {
            const pipelineLayout = this.pipelineLayout;
            const pipeline = this.pipelines[this.useDepthClipping ? 1 : 0];
            const constantBuffer = this.constantBuffer;
            const constantBufferView = this.constantBufferView;
            if (!pipelineLayout || !pipeline || !constantBuffer || !constantBufferView) {
                return;
            }
            const projection = perspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR);
            const view = this.camera.view();
            this.writeUniforms(constantBuffer, frameOffset, projection, view, 1.0, 0.0, 1);
            this.writeUniforms(constantBuffer, frameOffset + UBO_STRIDE, projection, view, -1.0, 1.0, -1);

            const model = this.models[this.objectIndex];
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, pipelineLayout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetIndexBuffer(commandBuffer, Nri_GetGltfMeshIndexBuffer(model), 0, NriIndexType.UInt32);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, Nri_GetGltfMeshVertexBuffer(model), 0, VERTEX_SIZE);
            for (let draw = 0; draw < 2; draw++) {
                if (!this.drawObject[draw] || (draw == 1 && !this.usePrimitiveClipping)) {
                    continue;
                }
                Nri_CmdSetRootDescriptor(commandBuffer, 0, constantBufferView, frameOffset + draw * UBO_STRIDE);
                Nri_CmdDrawIndexed(commandBuffer, Nri_GetGltfMeshIndexCount(model), 1, 0, 0, 0);
            }
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.handleMouse();

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: color cleared to dark gray, depth to 1, the object's draws; then the
                // settings window over them.
                Nri_BeginCommandBuffer(commandBuffer);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    Nri_CmdBeginRenderingWithDepth(commandBuffer, swapChainTexture.colorAttachment, depthAttachment);
                    Nri_CmdClearColor(commandBuffer, 0.1, 0.1, 0.1, 0.0);
                    Nri_CmdClearDepth(commandBuffer, 1.0);
                    this.recordDraw(commandBuffer, queuedFrameIndex * 2 * UBO_STRIDE);
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
                for (const model of this.models) {
                    Nri_DestroyGltfMesh(model);
                }
                this.destroyDescriptor(this.constantBufferView);
                this.destroyDescriptor(this.depthAttachment);
                const constantBuffer = this.constantBuffer;
                if (constantBuffer) {
                    Nri_DestroyBuffer(constantBuffer);
                }
                const depthTexture = this.depthTexture;
                if (depthTexture) {
                    Nri_DestroyTexture(depthTexture);
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    Nri_DestroyBuffer(readbackBuffer);
                }
                for (const pipeline of this.pipelines) {
                    this.destroyPipeline(pipeline);
                }
                const pipelineLayout = this.pipelineLayout;
                if (pipelineLayout) {
                    Nri_DestroyPipelineLayout(pipelineLayout);
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

        destroyPipeline(pipeline: NriPipelineHandle | null) {
            if (pipeline) {
                Nri_DestroyPipeline(pipeline);
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const clipping = new DynamicPrimitiveClipping(sample);
        // -object <n>: 0 teapot, 1 torus knot, 2 sphere; -visualization <n>: the clip distance
        // function (0 ... 8, as the UI lists them); -noclipping: primitive clipping off; -depthclip:
        // depth clipping on; -only <n>: draw only object 1 or 2; -noUI: no settings window.
        Nri_AddExampleOptionWithValues(sample, "-object", 1);
        Nri_AddExampleOptionWithValues(sample, "-visualization", 1);
        Nri_AddExampleOption(sample, "-noclipping");
        Nri_AddExampleOption(sample, "-depthclip");
        Nri_AddExampleOptionWithValues(sample, "-only", 1);
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        let only = 0;
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-object" && i + 1 < argc) {
                clipping.objectIndex = Math.min(MODEL_NAMES.length - 1, Math.max(0, parseInt(Nri_GetArg(argc, argv, i + 1))));
                i++;
            } else if (arg == "-visualization" && i + 1 < argc) {
                clipping.visualization = Math.min(VISUALIZATION_NAMES.length - 1, Math.max(0, parseInt(Nri_GetArg(argc, argv, i + 1))));
                i++;
            } else if (arg == "-noclipping") {
                clipping.usePrimitiveClipping = false;
            } else if (arg == "-depthclip") {
                clipping.useDepthClipping = true;
            } else if (arg == "-only" && i + 1 < argc) {
                only = parseInt(Nri_GetArg(argc, argv, i + 1));
                i++;
            } else if (arg == "-noUI") {
                clipping.noUI = true;
            }
        }
        if (only == 1 || only == 2) {
            clipping.drawObject[2 - only] = false;
        }
        return clipping.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return DynamicPrimitiveClippingNri.main(argc, argv);
}

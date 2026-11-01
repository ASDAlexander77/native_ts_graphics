/// <reference path="../../core/nri/nri_interop.d.ts" />
import { radians, perspective } from "../../core/matrix";
import { FirstPersonCamera } from "../../core/vulkan_samples_camera";

namespace PatchControlPointsNri {
    // patch_control_points, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead
    // of Donut and NVRHI: the same shaders (patch_control_points.hlsl's) and model (read as Donut's
    // loadGltfMesh reads it), through the NRI calls core/nri/nri_interop.d.ts binds, with
    // NRIFramework's ImGui for the sample's overlay. This example creates everything it runs, and does
    // the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Patch Control Points";

    // The sample's model (Vulkan-Samples' asset, copied at build time: see VULKAN_SAMPLES_ASSETS_DIR
    // in CMakeLists.txt).
    const MODEL_PATH = "media/patch_control_points/terrain.gltf";

    // Nri_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;

    // struct UBO { float4x4 projection, view; } and struct UBOTessellation { float
    // tessellationFactor; }, as f32 offsets; a queued frame's each in a 256-byte slice of the
    // constant buffer (D3D12 constant buffer views' alignment).
    const UBO_PROJECTION = 0;
    const UBO_VIEW = 16;
    const UBO_FLOATS = 32;
    const TESS_FLOATS = 4;
    const CONST_STRIDE = 256;
    // The push constants: float3 direction (at b2: root constants).
    const PUSH_FLOATS = 3;
    const PUSH_REGISTER = 2;

    // Where the sample draws the model, once with each pipeline.
    const DIRECTIONS = [
        2.5, -1.0, 3.0,        // first model
        0.0, -1.0, 3.0,        // second model
    ];

    // The sample's first person camera at (-1.25, -0.75, 1.5) (vkb::Camera's position, the view's
    // translation), not turned; reversed depth from 0.1 to 256.
    const CAMERA_POSITION = [-1.25, -0.75, 1.5];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;

    // GLFW's key codes of the camera's keys (W, S, A, D: Donut's Key values).
    const CAMERA_KEYS = [87, 83, 65, 68];

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into: its command buffer, and its descriptor set (its slices of
    // the UBO and of the tessellation UBO) with their views.
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public descriptorSet: NriDescriptorSetHandle | null, public uboView: NriDescriptorHandle | null,
            public tessView: NriDescriptorHandle | null) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // The pixels whose red, green and blue are each within their range (inclusive).
    function countInRange(pixels: int[], rMin: int, rMax: int, gMin: int, gMax: int, bMin: int, bMax: int): int {
        let count = 0;
        for (let i = 0; i < pixels.length; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r >= rMin && r <= rMax && g >= gMin && g <= gMax && b >= bMin && b <= bMax) {
                count++;
            }
        }
        return count;
    }

    // count is between min and max hundredths of total pixels; what names them in the failure.
    function share(count: int, total: int, min: number, max: number, what: string): string {
        const percent = 100.0 * count / total;
        console.log(`${what}: ${percent}% (${count} of ${total} pixels)`);
        if (percent < min || percent > max) {
            return `${what}: ${percent}% of the pixels, not ${min}% to ${max}%`;
        }
        return "";
    }

    // -test: checks the last frame, read back, as the Donut example does. The corners are black; the
    // tessellated terrains' red, blue and green wireframe edges each color 2.5% to 8% of the frame.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const xs = [0, width - 1, 0, width - 1];
        const ys = [0, 0, height - 1, height - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[ys[k] * width + xs[k]] & 0xFFFFFF;
            if (p != 0) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not 0, 0, 0`;
            }
        }
        const total = width * height;
        const red = share(countInRange(pixels, 151, 255, 0, 89, 0, 89), total, 2.5, 8.0, "Red");
        if (red != "") {
            return red;
        }
        const green = share(countInRange(pixels, 0, 89, 121, 255, 0, 89), total, 2.5, 8.0, "Green");
        if (green != "") {
            return green;
        }
        return share(countInRange(pixels, 0, 89, 0, 119, 121, 255), total, 2.5, 8.0, "Blue");
    }

    // Port of Vulkan-Samples' patch_control_points (as examples/patch_control_points.ts ports it) to
    // NRI: a terrain mesh drawn twice as tessellated triangle patches in wireframe, each patch's edges
    // tessellated by their distance from the camera (red: level 1, blue: 0.4 x the factor, green: the
    // factor). The sample's second pipeline sets its patch control point count as dynamic state; NRI
    // has none (nor have D3D's patch list topologies): both pipelines are made with 3, as in the Donut
    // example, and draw the same. Drawn straight into the sRGB swap chain view (Donut's sRGB back
    // buffer), with a D32 depth buffer.
    class PatchControlPoints {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private depthTexture: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private pipelineLayout: NriPipelineLayoutHandle | null = null;
        private staticPipeline: NriPipelineHandle | null = null;
        private dynamicPipeline: NriPipelineHandle | null = null;
        private model: NriGltfMeshHandle | null = null;
        private constantBuffer: NriBufferHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;

        private camera: FirstPersonCamera = new FirstPersonCamera(CAMERA_POSITION, [0.0, 0.0, 0.0]);
        // The mouse buttons and the camera's keys as the camera last saw them.
        private buttons: boolean[] = [false, false, false];
        private keys: boolean[] = [false, false, false, false];

        // The sample's settings (-notessellation, -level <3..7>); -noUI: no overlay.
        tessellation: boolean = true;
        tessLevel: number = 3.0;
        noUI: boolean = false;

        // Upload buffers.
        private ubo: f32[] = [];
        private tess: f32[] = [0.0, 0.0, 0.0, 0.0];
        private push: f32[] = [0.0, 0.0, 0.0];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
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

            // The depth buffer: D32, cleared to 0 (the sample's reversed depth).
            const depthTexture = Nri_CreateDepthTexture(device, this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
                console.log("Cannot create the depth buffer");
                return 0;
            }
            this.depthAttachment = Nri_CreateDepthAttachmentView(depthTexture, NriFormat.D32_SFLOAT);

            this.model = Nri_LoadGltfMesh(device, this.queue, MODEL_PATH);
            if (!this.model) {
                console.log("Cannot load the model: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }

            // The layout: the sample's descriptor set (the UBO at b0, the tessellation UBO at b1) and
            // push constants (the model's direction, at b2: root constants), seen by every stage.
            const stages = NriStage.VertexTessellationPixel;
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 2, NriDescriptorType.ConstantBuffer, stages, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRootConstants(layoutDesc, PUSH_REGISTER, PUSH_FLOATS * 4, stages);
            const pipelineLayout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            this.pipelineLayout = pipelineLayout;
            if (!pipelineLayout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The sample's two pipelines, made the same (see above).
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/patch_control_points/${folder}/patch_control_points`;
            this.staticPipeline = this.createPipeline(device, pipelineLayout, shaders);
            this.dynamicPipeline = this.createPipeline(device, pipelineLayout, shaders);
            if (!this.staticPipeline || !this.dynamicPipeline) {
                console.log("Cannot load the patch control points shaders");
                return 0;
            }

            // A queued frame's UBO and tessellation UBO, in its own descriptor set (both pipelines
            // get the same tessellation factor).
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * 2 * CONST_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const descriptorPool = Nri_CreateDescriptorPool(device, queuedFrameNum, 0, 2 * queuedFrameNum, 0, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!constantBuffer || !descriptorPool) {
                console.log("Cannot create the constant buffers");
                return 0;
            }
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const descriptorSet = Nri_AllocateDescriptorSet(descriptorPool, pipelineLayout, 0, 0);
                const uboView = Nri_CreateConstantBufferView(constantBuffer, 2 * i * CONST_STRIDE, CONST_STRIDE);
                const tessView = Nri_CreateConstantBufferView(constantBuffer, (2 * i + 1) * CONST_STRIDE, CONST_STRIDE);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), descriptorSet,
                    uboView, tessView));
                if (!descriptorSet || !uboView || !tessView) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(descriptorSet, 0, 0, uboView);
                Nri_UpdateDescriptor(descriptorSet, 0, 1, tessView);
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

        // The sample's create_pipelines: the position of the glTF loader's vertices, patches of 3
        // control points, wireframe, front faces (counter-clockwise) culled, alpha blended, reversed
        // depth (greater) tested and written.
        createPipeline(device: NriDeviceHandle, pipelineLayout: NriPipelineLayoutHandle, shaders: string) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_tess_vs.bin`, "tess_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Hull, `${shaders}_tess_hs.bin`, "tess_hs") != 0;
            }
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Domain, `${shaders}_tess_ds.bin`, "tess_ds") != 0;
            }
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_tess_ps.bin`, "tess_ps") != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescSetTopology(desc, NriTopology.PatchList);
            Nri_PipelineDescSetPatchControlPoints(desc, 3);
            Nri_PipelineDescSetWireframe(desc, 1);
            Nri_PipelineDescSetCullMode(desc, NriCullMode.Front);
            Nri_PipelineDescSetFrontCounterClockwise(desc, 1);
            Nri_PipelineDescSetColor(desc, this.viewFormat, NriColorWrite.RGBA);
            Nri_PipelineDescSetBlend(desc, NriBlendFactor.SrcAlpha, NriBlendFactor.OneMinusSrcAlpha, NriBlendOp.Add,
                NriBlendFactor.One, NriBlendFactor.Zero, NriBlendOp.Add);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.Greater, 1, 0);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, pipelineLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // Waits for the frame that last used this frame's command allocator (and its UBOs).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The camera's input (ApiVulkanSample's), the mouse unless the overlay has it; then its
        // movement over the frame's time (Donut's test mode: 1/60 s, as a float).
        handleInput() {
            const overlay = this.imgui && Nri_ImguiWantsMouse() != 0;
            for (let button = 0; button < 3; button++) {
                const pressed = Nri_IsButtonPressed(this.sample, button) != 0;
                if (pressed != this.buttons[button]) {
                    if (!pressed || !overlay) {
                        this.camera.mouseButton(<MouseButton>button, <Action>(pressed ? 1 : 0));
                        this.buttons[button] = pressed;
                    }
                }
            }
            if (!overlay) {
                this.camera.mouseMove(Nri_GetMouseX(this.sample), Nri_GetMouseY(this.sample));
            }
            for (let k = 0; k < 4; k++) {
                const pressed = Nri_IsKeyPressed(this.sample, CAMERA_KEYS[k]) != 0;
                if (pressed != this.keys[k]) {
                    this.camera.key(<Key>CAMERA_KEYS[k], <Action>(pressed ? 1 : 0));
                    this.keys[k] = pressed;
                }
            }
            this.camera.update(this.test ? Math.fround(1.0 / 60.0) : Nri_GetFrameTime(this.sample));
        }

        // The sample's overlay.
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPos(10.0, 10.0);
            Nri_ImguiBegin("Patch Control Points", 1);
            Nri_ImguiPushItemWidth(110.0);
            if (Nri_ImguiCollapsingHeader("Settings", 1) != 0) {
                this.tessellation = Nri_ImguiCheckbox("Tessellation Enable", this.tessellation ? 1 : 0) != 0;
                // Maximum tessellation level is set to 7.0
                this.tessLevel = Nri_ImguiSliderFloat("Tessellation level", this.tessLevel, 3.0, 7.0);
            }
            Nri_ImguiPopItemWidth();
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        // The sample's update_uniform_buffers: its projection (clip y negated, as the Donut example
        // gives it) and view; the tessellation factor (1 when tessellation is off).
        writeConstants(constantBuffer: NriBufferHandle, queuedFrameIndex: int) {
            const projection = perspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR);
            const view = this.camera.view();
            for (let i = 0; i < 16; i++) {
                this.ubo[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                this.ubo[UBO_VIEW + i] = view[i];
            }
            this.tess[0] = this.tessellation ? this.tessLevel : 1.0;
            Nri_WriteBuffer(constantBuffer, 2 * queuedFrameIndex * CONST_STRIDE, Ref(this.ubo[0]), UBO_FLOATS * 4);
            Nri_WriteBuffer(constantBuffer, (2 * queuedFrameIndex + 1) * CONST_STRIDE, Ref(this.tess[0]), TESS_FLOATS * 4);
        }

        // The model with a pipeline, at its direction (between Nri_CmdBeginRenderingWithDepth and
        // Nri_CmdEndRendering).
        drawModel(commandBuffer: NriCommandBufferHandle, pipeline: NriPipelineHandle | null, model: int) {
            const mesh = this.model;
            if (!pipeline || !mesh) {
                return;
            }
            for (let i = 0; i < 3; i++) {
                this.push[i] = DIRECTIONS[model * 3 + i];
            }
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.push[0]), PUSH_FLOATS * 4);
            Nri_CmdSetIndexBuffer(commandBuffer, Nri_GetGltfMeshIndexBuffer(mesh), 0, NriIndexType.UInt32);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, Nri_GetGltfMeshVertexBuffer(mesh), 0, VERTEX_SIZE);
            Nri_CmdDrawIndexed(commandBuffer, Nri_GetGltfMeshIndexCount(mesh), 1, 0, 0, 0);
        }

        // The model with each pipeline.
        recordDraw(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const pipelineLayout = this.pipelineLayout;
            const descriptorPool = this.descriptorPool;
            const descriptorSet = queuedFrame.descriptorSet;
            if (!pipelineLayout || !descriptorPool || !descriptorSet) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, pipelineLayout);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, descriptorSet);
            this.drawModel(commandBuffer, this.staticPipeline, 0);
            this.drawModel(commandBuffer, this.dynamicPipeline, 1);
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.handleInput();
            const constantBuffer = this.constantBuffer;
            if (constantBuffer) {
                this.writeConstants(constantBuffer, queuedFrameIndex);
            }

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: color cleared to transparent black, depth to 0 (reversed), the two models;
                // then the overlay over them.
                Nri_BeginCommandBuffer(commandBuffer);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    Nri_CmdBeginRenderingWithDepth(commandBuffer, swapChainTexture.colorAttachment, depthAttachment);
                    Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 0.0);
                    Nri_CmdClearDepth(commandBuffer, 0.0);
                    this.recordDraw(commandBuffer, queuedFrame);
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
                    this.destroyDescriptor(queuedFrame.uboView);
                    this.destroyDescriptor(queuedFrame.tessView);
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
                this.destroyDescriptor(this.depthAttachment);
                const depthTexture = this.depthTexture;
                if (depthTexture) {
                    Nri_DestroyTexture(depthTexture);
                }
                const model = this.model;
                if (model) {
                    Nri_DestroyGltfMesh(model);
                }
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.staticPipeline);
                this.destroyPipeline(this.dynamicPipeline);
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
        const patchControlPoints = new PatchControlPoints(sample);
        // -notessellation, -level <3..7>: the settings' initial values; -noUI: no overlay.
        Nri_AddExampleOption(sample, "-notessellation");
        Nri_AddExampleOptionWithValues(sample, "-level", 1);
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-notessellation") {
                patchControlPoints.tessellation = false;
            } else if (arg == "-level" && i + 1 < argc) {
                i++;
                patchControlPoints.tessLevel = Math.min(Math.max(parseFloat(Nri_GetArg(argc, argv, i)), 3.0), 7.0);
            } else if (arg == "-noUI") {
                patchControlPoints.noUI = true;
            }
        }
        return patchControlPoints.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return PatchControlPointsNri.main(argc, argv);
}

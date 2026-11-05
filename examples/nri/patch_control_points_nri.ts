/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { radians, perspective } from "../../core/matrix";
import { FirstPersonCamera } from "../../core/vulkan_samples_camera";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriGltfMesh, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

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

    // NriDevice.loadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
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

    // A frame in flight's own data: its descriptor set (its slices of
    // the UBO and of the tessellation UBO) with their views.
    class QueuedFrame {
        constructor(public descriptorSet: NriDescriptorSet | null, public uboView: NriDescriptor | null,
            public tessView: NriDescriptor | null) {
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
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        // The swap chain textures' format and their views' (sRGB).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private viewFormat: NriFormat = NriFormat.Unknown;
        private depthTexture: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
        private pipelineLayout: NriPipelineLayout | null = null;
        private staticPipeline: NriPipeline | null = null;
        private dynamicPipeline: NriPipeline | null = null;
        private model: NriGltfMesh | null = null;
        private constantBuffer: NriBuffer | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private imgui: boolean = false;
        // The swap chain's size: the window's when it was (re)created.
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
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
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
            this.sample.setInitializeCallback(initialize);
            this.sample.setLatencySleepCallback(latencySleep);
            this.sample.setRenderFrameCallback(renderFrame);

            let result = this.sample.run(argc, argv, WINDOW_TITLE, TEST_FRAMES);
            if (result == 0 && this.test) {
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

            // Swap chain: rendered through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;

            // The depth buffer: D32, cleared to 0 (the sample's reversed depth).
            if (!this.createDepth(device)) {
                console.log("Cannot create the depth buffer");
                return 0;
            }

            this.model = device.loadGltfMesh(this.queue, MODEL_PATH);
            if (!this.model) {
                console.log("Cannot load the model: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }

            // The layout: the sample's descriptor set (the UBO at b0, the tessellation UBO at b1) and
            // push constants (the model's direction, at b2: root constants), seen by every stage.
            const stages = NriStage.VertexTessellationPixel;
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRange(0, 0, 2, NriDescriptorType.ConstantBuffer, stages, NriRangeFlags.None);
            layoutDesc.addRootConstants(PUSH_REGISTER, PUSH_FLOATS * 4, stages);
            const pipelineLayout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
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
            const constantBuffer = device.createHostBuffer(queuedFrameNum * 2 * CONST_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const descriptorPool = device.createDescriptorPool(queuedFrameNum, 0, 2 * queuedFrameNum, 0, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!constantBuffer || !descriptorPool) {
                console.log("Cannot create the constant buffers");
                return 0;
            }
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const descriptorSet = descriptorPool.allocateDescriptorSet(pipelineLayout, 0, 0);
                const uboView = constantBuffer.createConstantView(2 * i * CONST_STRIDE, CONST_STRIDE);
                const tessView = constantBuffer.createConstantView((2 * i + 1) * CONST_STRIDE, CONST_STRIDE);
                this.queuedFrames.push(new QueuedFrame(descriptorSet,
                    uboView, tessView));
                if (!descriptorSet || !uboView || !tessView) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                descriptorSet.updateDescriptor(0, 0, uboView);
                descriptorSet.updateDescriptor(0, 1, tessView);
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

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The D32 depth buffer at the swap chain's size; false on failure.
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

        // The window was resized (NriSample.useResizableWindow): the swap chain and the depth buffer made again at its size, once the
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
            this.destroyDepth();
            this.swapChain.recreate();
            this.sizeToSwapChain();
            this.createDepth(device);
        }

        // The sample's create_pipelines: the position of the glTF loader's vertices, patches of 3
        // control points, wireframe, front faces (counter-clockwise) culled, alpha blended, reversed
        // depth (greater) tested and written.
        createPipeline(device: NriDevice, pipelineLayout: NriPipelineLayout, shaders: string) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_tess_vs.bin`, "tess_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Hull, `${shaders}_tess_hs.bin`, "tess_hs") != 0;
            }
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Domain, `${shaders}_tess_ds.bin`, "tess_ds") != 0;
            }
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_tess_ps.bin`, "tess_ps") != 0;
            }
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            desc.setTopology(NriTopology.PatchList);
            desc.setPatchControlPoints(3);
            desc.setWireframe(1);
            desc.setCullMode(NriCullMode.Front);
            desc.setFrontCounterClockwise(1);
            desc.setColor(this.viewFormat, NriColorWrite.RGBA);
            desc.setBlend(NriBlendFactor.SrcAlpha, NriBlendFactor.OneMinusSrcAlpha, NriBlendOp.Add,
                NriBlendFactor.One, NriBlendFactor.Zero, NriBlendOp.Add);
            desc.setDepth(NriFormat.D32_SFLOAT, NriCompareOp.Greater, 1, 0);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(pipelineLayout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        // Waits for the frame that last used this frame's command allocator (and its UBOs).
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The camera's input (ApiVulkanSample's), the mouse unless the overlay has it; then its
        // movement over the frame's time (Donut's test mode: 1/60 s, as a float).
        handleInput() {
            const overlay = this.imgui && NriImgui.wantsMouse() != 0;
            for (let button = 0; button < 3; button++) {
                const pressed = this.sample.isButtonPressed(button) != 0;
                if (pressed != this.buttons[button]) {
                    if (!pressed || !overlay) {
                        this.camera.mouseButton(<MouseButton>button, <Action>(pressed ? 1 : 0));
                        this.buttons[button] = pressed;
                    }
                }
            }
            if (!overlay) {
                this.camera.mouseMove(this.sample.getMouseX(), this.sample.getMouseY());
            }
            for (let k = 0; k < 4; k++) {
                const pressed = this.sample.isKeyPressed(CAMERA_KEYS[k]) != 0;
                if (pressed != this.keys[k]) {
                    this.camera.key(<Key>CAMERA_KEYS[k], <Action>(pressed ? 1 : 0));
                    this.keys[k] = pressed;
                }
            }
            this.camera.update(this.test ? Math.fround(1.0 / 60.0) : this.sample.getFrameTime());
        }

        // The sample's overlay.
        buildUI() {
            this.sample.imguiNewFrame();
            NriImgui.setNextWindowPos(10.0, 10.0);
            NriImgui.begin("Patch Control Points", 1);
            NriImgui.pushItemWidth(110.0);
            if (NriImgui.collapsingHeader("Settings", 1) != 0) {
                this.tessellation = NriImgui.checkbox("Tessellation Enable", this.tessellation ? 1 : 0) != 0;
                // Maximum tessellation level is set to 7.0
                this.tessLevel = NriImgui.sliderFloat("Tessellation level", this.tessLevel, 3.0, 7.0);
            }
            NriImgui.popItemWidth();
            NriImgui.end();
            this.sample.imguiRender();
        }

        // The sample's update_uniform_buffers: its projection (clip y negated, as the Donut example
        // gives it) and view; the tessellation factor (1 when tessellation is off).
        writeConstants(constantBuffer: NriBuffer, queuedFrameIndex: int) {
            const projection = perspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR);
            const view = this.camera.view();
            for (let i = 0; i < 16; i++) {
                this.ubo[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                this.ubo[UBO_VIEW + i] = view[i];
            }
            this.tess[0] = this.tessellation ? this.tessLevel : 1.0;
            constantBuffer.write(2 * queuedFrameIndex * CONST_STRIDE, Ref(this.ubo[0]), UBO_FLOATS * 4);
            constantBuffer.write((2 * queuedFrameIndex + 1) * CONST_STRIDE, Ref(this.tess[0]), TESS_FLOATS * 4);
        }

        // The model with a pipeline, at its direction (between NriCommandBuffer.beginRenderingWithDepth and
        // NriCommandBuffer.endRendering).
        drawModel(commandBuffer: NriCommandBuffer, pipeline: NriPipeline | null, model: int) {
            const mesh = this.model;
            if (!pipeline || !mesh) {
                return;
            }
            for (let i = 0; i < 3; i++) {
                this.push[i] = DIRECTIONS[model * 3 + i];
            }
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setRootConstants(0, Ref(this.push[0]), PUSH_FLOATS * 4);
            commandBuffer.setIndexBuffer(mesh.getIndexBuffer(), 0, NriIndexType.UInt32);
            commandBuffer.setVertexBuffer(0, mesh.getVertexBuffer(), 0, VERTEX_SIZE);
            commandBuffer.drawIndexed(mesh.getIndexCount(), 1, 0, 0, 0);
        }

        // The model with each pipeline.
        recordDraw(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const pipelineLayout = this.pipelineLayout;
            const descriptorPool = this.descriptorPool;
            const descriptorSet = queuedFrame.descriptorSet;
            if (!pipelineLayout || !descriptorPool || !descriptorSet) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(pipelineLayout);
            commandBuffer.setDescriptorSet(0, descriptorSet);
            this.drawModel(commandBuffer, this.staticPipeline, 0);
            this.drawModel(commandBuffer, this.dynamicPipeline, 1);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
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
            const index = this.swapChain.acquire(frameIndex);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: color cleared to transparent black, depth to 0 (reversed), the two models;
                // then the overlay over them.
                commandBuffer.begin();
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    commandBuffer.beginRenderingWithDepth(this.swapChain.colorAttachment(index), depthAttachment);
                    commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
                    commandBuffer.clearDepth(0.0);
                    this.recordDraw(commandBuffer, queuedFrame);
                    commandBuffer.endRendering();
                }
                // (A pass of its own: the UI's pipeline has no depth attachment.)
                if (this.imgui) {
                    this.sample.copyImguiData(commandBuffer);
                    commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                    this.sample.drawImgui(commandBuffer, this.viewFormat);
                    commandBuffer.endRendering();
                }

                // The test's last frame: read back
                let presentFrom = NriTextureState.ColorAttachment;
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    if (frameIndex == TEST_FRAMES - 1) {
                        commandBuffer.textureBarrier(texture, NriTextureState.ColorAttachment, NriTextureState.CopySource);
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
                    this.destroyDescriptor(queuedFrame.tessView);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                this.destroyDepth();
                const model = this.model;
                if (model) {
                    model.destroy();
                }
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.staticPipeline);
                this.destroyPipeline(this.dynamicPipeline);
                const pipelineLayout = this.pipelineLayout;
                if (pipelineLayout) {
                    pipelineLayout.destroy();
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
        const patchControlPoints = new PatchControlPoints(sample);
        // -notessellation, -level <3..7>: the settings' initial values; -noUI: no overlay.
        sample.addExampleOption("-notessellation");
        sample.addExampleOptionWithValues("-level", 1);
        sample.addExampleOption("-noUI");
        sample.useImgui();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-notessellation") {
                patchControlPoints.tessellation = false;
            } else if (arg == "-level" && i + 1 < argc) {
                i++;
                patchControlPoints.tessLevel = Math.min(Math.max(parseFloat(Nri.getArg(argc, argv, i)), 3.0), 7.0);
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

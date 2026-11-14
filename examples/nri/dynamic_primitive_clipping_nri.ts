/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { identity, rotate, radians, perspective } from "../../core/matrix";
import { comboItems } from "../../core/text_format";
import { LookAtCamera } from "../../core/vulkan_samples_camera";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDevice, NriGltfMesh, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

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

    // NriDevice.loadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
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
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        // The swap chain textures' format and their views'.
        private swapChainFormat: NriFormat = 0;
        private swapChainViewFormat: NriFormat = 0;
        private viewFormat: NriFormat = NriFormat.Unknown;
        private pipelineLayout: NriPipelineLayout | null = null;
        // Without depth clipping, then with it.
        private pipelines: (NriPipeline | null)[] = [];
        private models: NriGltfMesh[] = [];
        private constantBuffer: NriBuffer | null = null;
        private constantBufferView: NriDescriptor | null = null;
        private depthTexture: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
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
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
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
            this.sample.setInitializeCallback(initialize);
            this.sample.setLatencySleepCallback(latencySleep);
            this.sample.setRenderFrameCallback(renderFrame);

            // On a wrapper of its own: the callbacks Nri_RunSample runs may overwrite this.sample.
            let result = new NriSample(this.sample.handle).run(argc, argv, WINDOW_TITLE, TEST_FRAMES);
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

            // Swap chain: rendered through sRGB views, as the Donut example's sRGB back buffer.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.swapChainViewFormat;

            // Queued frames
            this.frames.init(device, this.queue, queuedFrameNum);

            // The models.
            for (const modelPath of MODEL_PATHS) {
                const model = device.loadGltfMesh(this.queue, modelPath);
                if (!model) {
                    console.log("Cannot load the models: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                    return 0;
                }
                this.models.push(model);
            }

            // The layout: the UBO (b0), a root descriptor bound at each draw's slice.
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRootDescriptor(0, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel);
            this.pipelineLayout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
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
                const desc = NriPipelineDesc.create();
                let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_main_vs.bin`, "main_vs") != 0;
                if (loaded) {
                    loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_main_ps.bin`, "main_ps") != 0;
                }
                desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
                desc.addVertexAttribute("NORMAL", NriFormat.RGB32_SFLOAT, 12);
                desc.setColor(viewFormat, NriColorWrite.RGBA);
                desc.setDepth(NriFormat.D32_SFLOAT, NriCompareOp.Less, 1, 0);
                desc.setDepthClip(clip);
                let pipeline: NriPipeline | null = null;
                if (loaded) {
                    pipeline = device.createPipelineFromDesc(pipelineLayout, desc);
                }
                desc.destroy();
                if (!pipeline) {
                    console.log("Cannot load the dynamic primitive clipping shaders");
                    return 0;
                }
                this.pipelines.push(pipeline);
            }

            // The UBOs, two draws a queued frame; the depth buffer.
            const constantBuffer = device.createHostBuffer(queuedFrameNum * 2 * UBO_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            if (!constantBuffer || !this.createSizeTargets(device)) {
                console.log("Cannot create the constant and depth buffers");
                return 0;
            }
            this.constantBufferView = constantBuffer.createConstantView(0, UBO_STRIDE);

            // The sample's settings.
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

        // Waits for the frame that last used this frame's command allocator (and its UBOs).
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The camera's mouse handling (ApiVulkanSample's), unless the settings window has the
        // mouse: the buttons' changes, then the cursor's position.
        handleMouse() {
            const overlay = this.imgui && NriImgui.wantsMouse() != 0;
            for (let button = 0; button < 3; button++) {
                const pressed = this.sample.isButtonPressed(button) != 0;
                if (pressed != this.buttons[button]) {
                    if (!pressed || !overlay) {
                        this.camera.mouseButton(<MouseButton>button, <Action>(pressed ? 1 : 0));
                    }
                    this.buttons[button] = pressed;
                }
            }
            this.camera.mouseMove(this.sample.getMouseX(), this.sample.getMouseY());
        }

        // The sample's settings.
        buildUI() {
            this.sample.imguiNewFrame();
            NriImgui.setNextWindowPos(10.0, 10.0);
            NriImgui.begin("Options", 1);
            if (NriImgui.collapsingHeader("Settings", 1) != 0) {
                this.objectIndex = NriImgui.combo("Object type", this.objectIndex, comboItems(MODEL_NAMES));
                this.usePrimitiveClipping = NriImgui.checkbox("Use primitive clipping", this.usePrimitiveClipping ? 1 : 0) != 0;
                this.visualization = NriImgui.combo("Visualization", this.visualization, comboItems(VISUALIZATION_NAMES));
                this.drawObject[0] = NriImgui.checkbox("Draw object 1", this.drawObject[0] ? 1 : 0) != 0;
                this.drawObject[1] = NriImgui.checkbox("Draw object 2", this.drawObject[1] ? 1 : 0) != 0;
                this.useDepthClipping = NriImgui.checkbox("Use depth clipping", this.useDepthClipping ? 1 : 0) != 0;
            }
            NriImgui.end();
            this.sample.imguiRender();
        }

        // The sample's update_uniform_buffers for one draw (at offset in the constant buffer): its
        // color transformation and clip distance sign.
        writeUniforms(constantBuffer: NriBuffer, offset: int, projection: number[], view: number[], colorScale: number,
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
            Nri.storeInt32(Ref(u[UBO_SCENE_TRANSFORMATION]), this.visualization);
            Nri.storeInt32(Ref(u[UBO_SCENE_TRANSFORMATION + 1]), sign);
            u[UBO_USE_PRIMITIVE_CLIPPING] = this.usePrimitiveClipping ? 1.0 : -1.0;
            constantBuffer.write(offset, Ref(u[0]), UBO_FLOATS * 4);
        }

        // The object, then (with primitive clipping) the same object with the clip distances negated
        // (between NriCommandBuffer.beginRenderingWithDepth and NriCommandBuffer.endRendering); this queued frame's UBOs
        // from frameOffset.
        recordDraw(commandBuffer: NriCommandBuffer, frameOffset: int) {
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
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(pipelineLayout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setIndexBuffer(model.getIndexBuffer(), 0, NriIndexType.UInt32);
            commandBuffer.setVertexBuffer(0, model.getVertexBuffer(), 0, VERTEX_SIZE);
            for (let draw = 0; draw < 2; draw++) {
                if (!this.drawObject[draw] || (draw == 1 && !this.usePrimitiveClipping)) {
                    continue;
                }
                commandBuffer.setRootDescriptor(0, constantBufferView, frameOffset + draw * UBO_STRIDE);
                commandBuffer.drawIndexed(model.getIndexCount(), 1, 0, 0, 0);
            }
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.viewFormat = this.swapChain.viewFormat();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
        }

        // The window-size targets: the depth buffer (D32) and its attachment view; false if it can't
        // be created.
        createSizeTargets(device: NriDevice): boolean {
            const depthTexture = device.createDepthTexture(this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
                return false;
            }
            this.depthAttachment = depthTexture.createDepthAttachmentView(NriFormat.D32_SFLOAT);
            return true;
        }

        destroySizeTargets() {
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

        // The window was resized (NriSample.useResizableWindow): the swap chain and the window-size targets made again at its
        // size, once the GPU is done with the old ones.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (!this.swapChain.resized()) {
                return;
            }
            this.swapChain.recreate();
            this.sizeToSwapChain();
            this.destroySizeTargets();
            this.createSizeTargets(device);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.frames.size();
            if (this.imgui) {
                this.buildUI();
            }
            this.handleMouse();

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: color cleared to dark gray, depth to 1, the object's draws; then the
                // settings window over them.
                commandBuffer.begin();
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    commandBuffer.beginRenderingWithDepth(this.swapChain.colorAttachment(index), depthAttachment);
                    commandBuffer.clearColor(0.1, 0.1, 0.1, 0.0);
                    commandBuffer.clearDepth(1.0);
                    this.recordDraw(commandBuffer, queuedFrameIndex * 2 * UBO_STRIDE);
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
                for (const model of this.models) {
                    model.destroy();
                }
                this.destroyDescriptor(this.constantBufferView);
                const constantBuffer = this.constantBuffer;
                if (constantBuffer) {
                    constantBuffer.destroy();
                }
                this.destroySizeTargets();
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    readbackBuffer.destroy();
                }
                for (const pipeline of this.pipelines) {
                    this.destroyPipeline(pipeline);
                }
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

        destroyPipeline(pipeline: NriPipeline | null) {
            if (pipeline) {
                pipeline.destroy();
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const clipping = new DynamicPrimitiveClipping(sample);
        // -object <n>: 0 teapot, 1 torus knot, 2 sphere; -visualization <n>: the clip distance
        // function (0 ... 8, as the UI lists them); -noclipping: primitive clipping off; -depthclip:
        // depth clipping on; -only <n>: draw only object 1 or 2; -noUI: no settings window.
        sample.addExampleOptionWithValues("-object", 1);
        sample.addExampleOptionWithValues("-visualization", 1);
        sample.addExampleOption("-noclipping");
        sample.addExampleOption("-depthclip");
        sample.addExampleOptionWithValues("-only", 1);
        sample.addExampleOption("-noUI");
        sample.useImgui();
        let only = 0;
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-object" && i + 1 < argc) {
                clipping.objectIndex = Math.min(MODEL_NAMES.length - 1, Math.max(0, parseInt(Nri.getArg(argc, argv, i + 1))));
                i++;
            } else if (arg == "-visualization" && i + 1 < argc) {
                clipping.visualization = Math.min(VISUALIZATION_NAMES.length - 1, Math.max(0, parseInt(Nri.getArg(argc, argv, i + 1))));
                i++;
            } else if (arg == "-noclipping") {
                clipping.usePrimitiveClipping = false;
            } else if (arg == "-depthclip") {
                clipping.useDepthClipping = true;
            } else if (arg == "-only" && i + 1 < argc) {
                only = parseInt(Nri.getArg(argc, argv, i + 1));
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

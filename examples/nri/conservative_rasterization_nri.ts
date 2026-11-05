/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { multiply, rotation, translation, radians, samplePerspective } from "../../core/matrix";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace ConservativeRasterizationNri {
    // conservative_rasterization, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework
    // instead of Donut and NVRHI: the same shaders (conservative_rasterization.hlsl's), through the NRI
    // calls core/nri/nri_interop.d.ts binds, with NRIFramework's ImGui for the sample's overlay. This
    // example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no conservative rasterization.
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Conservative Rasterization";

    // The low resolution target is the screen's size divided by this.
    const ZOOM_FACTOR = 16;

    // struct SceneConstants { float4x4 projection, model; float2 viewportSize; float lineWidth,
    // padding; }, as f32 offsets; a queued frame's slice of the constant buffer (a constant buffer
    // view's 256-byte multiple).
    const CONST_PROJECTION = 0;
    const CONST_MODEL = 16;
    const CONST_VIEWPORT_SIZE = 32;
    const CONST_LINE_WIDTH = 34;
    const CONST_FLOATS = 36;
    const CONST_SLICE = 256;

    // The outline's width (the sample's lineWidth).
    const LINE_WIDTH = 2.0;

    // The triangle: float3 position, float3 color per vertex.
    const VERTEX_SIZE = 24;

    // The sample's camera: a "look at" camera 2 units back, 60 degrees vertically, reversed depth
    // from 512 to 0.1 (glm::perspective with near and far swapped).
    const CAMERA_POSITION = [0.0, 0.0, -2.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 512.0;
    const Z_FAR = 0.1;
    // ApiVulkanSample's mouse controls: degrees per pixel dragged with the left button, zoom per
    // pixel with the right one, panning per pixel with the middle one.
    const ROTATION_SPEED = 1.0;
    const ZOOM_SPEED = 0.005;
    const PAN_SPEED = 0.01;

    // The clear colors of the low resolution target and of the screen.
    const CLEAR_COLOR = 0.05;

    // NriSample.isButtonPressed's buttons.
    const MOUSE_LEFT = 0;
    const MOUSE_RIGHT = 1;
    const MOUSE_MIDDLE = 2;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // printf's %f: 6 decimals.
    function formatFloat(value: number) {
        const scaled = Math.round(value * 1000000.0);
        const whole = Math.floor(scaled / 1000000);
        let fraction = `${scaled - whole * 1000000}`;
        while (fraction.length < 6) {
            fraction = "0" + fraction;
        }
        return `${whole}.${fraction}`;
    }

    function yesNo(value: number) {
        return value != 0.0 ? "yes" : "no";
    }

    // A frame in flight's own data: its sets (its slice of the constant buffer).
    class QueuedFrame {
        constructor(public constantView: NriDescriptor, public sceneSet: NriDescriptorSet) {
        }
    }

    // -test: checks the last frame, read back, as the Donut example does. The corners are the gray
    // clear color; the triangle, rasterized conservatively at low resolution and then at full, colors
    // about a fifth of the frame (more on Vulkan, with its extra overestimation), its middle included.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const background = 0x404040;
        const xs = [0, width - 1, 0, width - 1];
        const ys = [0, 0, height - 1, height - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[ys[k] * width + xs[k]] & 0xFFFFFF;
            if (p != background) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not 64, 64, 64`;
            }
        }
        if ((pixels[Math.floor(height / 2) * width + Math.floor(width / 2)] & 0xFFFFFF) == background) {
            return "no triangle in the middle";
        }
        // TestCheck.countSpread(61): pixels whose channels differ by 61 or more (colored, not gray).
        let triangle = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
            const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
            if (max - min >= 61) {
                triangle++;
            }
        }
        const total = width * height;
        const percent = 100.0 * triangle / total;
        console.log(`Triangle: ${percent}% (${triangle} of ${total} pixels)`);
        if (percent < 15.0 || percent > 32.0) {
            return `Triangle: ${percent}% of the pixels, not 15% to 32%`;
        }
        return "";
    }

    // Port of Vulkan-Samples' conservative_rasterization (as examples/conservative_rasterization.ts
    // ports it) to NRI: a triangle drawn into a target 16 times smaller than the screen, with or
    // without conservative rasterization (every pixel the triangle touches at all, the sample
    // enlarging it further by the device's maximum extra size on Vulkan), then stretched over the
    // screen without filtering, with the triangle's real outline drawn over it. Dragging with the left
    // mouse button turns the camera, with the right one zooms, with the middle one pans.
    class ConservativeRasterization {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        // The swap chain textures' format (its views' are viewFormat).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private viewFormat: NriFormat = NriFormat.Unknown;
        private sceneLayout: NriPipelineLayout | null = null;
        private fullscreenLayout: NriPipelineLayout | null = null;
        private trianglePipeline: NriPipeline | null = null;
        private triangleConservativePipeline: NriPipeline | null = null;
        private overlayPipeline: NriPipeline | null = null;
        private fullscreenPipeline: NriPipeline | null = null;
        private shaders: string = "";
        private vertexBuffer: NriBuffer | null = null;
        private indexBuffer: NriBuffer | null = null;
        private constantBuffer: NriBuffer | null = null;
        private sampler: NriDescriptor | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private fullscreenSet: NriDescriptorSet | null = null;
        // The low resolution target (the screen's size divided by ZOOM_FACTOR), RGBA8_UNORM.
        private offscreenColor: NriTexture | null = null;
        private offscreenAttachment: NriDescriptor | null = null;
        private offscreenView: NriDescriptor | null = null;
        private offscreenWidth: int = 0;
        private offscreenHeight: int = 0;
        private imgui: boolean = false;
        // The swap chain's size: the window's when it was (re)created.
        private width: int = 0;
        private height: int = 0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        // The sample's settings: -noconservative starts with conservative rasterization off; -noUI: no
        // overlay.
        conservativeRasterEnabled: boolean = true;
        noUI: boolean = false;
        // The device's properties, for the overlay: Vulkan's (9 values, see
        // NriDevice.getVulkanConservativeRasterizationProperties), or the D3D tier.
        private hasVulkanProperties: boolean = false;
        private vulkanProperties: f32[] = [];
        private tier: int = 0;

        // The sample's camera: rotation (degrees about x, y, z) and position.
        private cameraRotation: number[] = [0.0, 0.0, 0.0];
        private cameraPosition: number[] = [CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]];
        private constants: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
            for (let i = 0; i < 9; i++) {
                this.vulkanProperties.push(0.0);
            }
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.constants.push(0.0);
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
            if (this.unsupportedReason != "") {
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
            const viewFormat = this.viewFormat;

            if (device.isFeatureSupported(NriFeature.ConservativeRasterization) == 0) {
                this.unsupportedReason = "This example needs conservative rasterization";
                return 0;
            }
            this.hasVulkanProperties = device.getVulkanConservativeRasterizationProperties(Ref(this.vulkanProperties[0])) != 0;
            this.tier = device.getConservativeRasterTier();

            // The layouts: the scene's constants (b0) for the vertex, geometry and pixel shaders; the
            // low resolution image (t0) and its sampler (s0) for the full screen pass.
            const sceneLayoutDesc = NriPipelineLayoutDesc.create();
            sceneLayoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexGeometry | NriStage.Pixel,
                NriRangeFlags.None);
            const sceneLayout = device.createPipelineLayoutFromDesc(sceneLayoutDesc);
            sceneLayoutDesc.destroy();
            this.sceneLayout = sceneLayout;
            const fullscreenLayoutDesc = NriPipelineLayoutDesc.create();
            fullscreenLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            fullscreenLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            const fullscreenLayout = device.createPipelineLayoutFromDesc(fullscreenLayoutDesc);
            fullscreenLayoutDesc.destroy();
            this.fullscreenLayout = fullscreenLayout;
            if (!sceneLayout || !fullscreenLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The low resolution target: the screen's size divided by ZOOM_FACTOR (made again at the
            // new size when the window is resized, unlike the sample's offscreen pass).
            if (!this.createOffscreen(device)) {
                console.log("Cannot create the low resolution target");
                return 0;
            }
            const offscreenView = this.offscreenView;

            // The pipelines: conservative_rasterization.hlsl's shaders, as compiled for the Donut
            // example.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : (graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv");
            this.shaders = `shaders/conservative_rasterization/${folder}/conservative_rasterization`;
            this.trianglePipeline = this.createTrianglePipeline(device, sceneLayout, false);
            this.triangleConservativePipeline = this.createTrianglePipeline(device, sceneLayout, true);

            // The outline over the screen: the edges widened by the geometry shader, no culling.
            const overlayDesc = NriPipelineDesc.create();
            let loaded = overlayDesc.addShader(NriShaderStage.Vertex, `${this.shaders}_triangle_vs.bin`, "triangle_vs") != 0;
            if (loaded) {
                loaded = overlayDesc.addShader(NriShaderStage.Geometry, `${this.shaders}_overlay_gs.bin`, "overlay_gs") != 0;
            }
            if (loaded) {
                loaded = overlayDesc.addShader(NriShaderStage.Pixel, `${this.shaders}_overlay_ps.bin`, "overlay_ps") != 0;
            }
            overlayDesc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            overlayDesc.addVertexAttribute("COLOR", NriFormat.RGB32_SFLOAT, 12);
            overlayDesc.setCullMode(NriCullMode.None);
            overlayDesc.setColor(viewFormat, NriColorWrite.RGBA);
            if (loaded) {
                this.overlayPipeline = device.createPipelineFromDesc(sceneLayout, overlayDesc);
            }
            overlayDesc.destroy();

            // The low resolution image over the screen.
            const fullscreenDesc = NriPipelineDesc.create();
            loaded = fullscreenDesc.addShader(NriShaderStage.Vertex, `${this.shaders}_fullscreen_vs.bin`, "fullscreen_vs") != 0;
            if (loaded) {
                loaded = fullscreenDesc.addShader(NriShaderStage.Pixel, `${this.shaders}_fullscreen_ps.bin`, "fullscreen_ps") != 0;
            }
            fullscreenDesc.setCullMode(NriCullMode.Back);
            fullscreenDesc.setColor(viewFormat, NriColorWrite.RGBA);
            if (loaded) {
                this.fullscreenPipeline = device.createPipelineFromDesc(fullscreenLayout, fullscreenDesc);
            }
            fullscreenDesc.destroy();
            if (!this.trianglePipeline || !this.triangleConservativePipeline || !this.overlayPipeline || !this.fullscreenPipeline) {
                console.log("Cannot load the conservative rasterization shaders");
                return 0;
            }

            // A single triangle.
            const vertices: f32[] = [
                1.0, 1.0, 0.0, 1.0, 0.0, 0.0,
                -1.0, 1.0, 0.0, 0.0, 1.0, 0.0,
                0.0, -1.0, 0.0, 0.0, 0.0, 1.0,
            ];
            const indices: int[] = [0, 1, 2];
            this.vertexBuffer = device.createUploadedBuffer(this.queue, Ref(vertices[0]), 3 * VERTEX_SIZE, NriBufferUsage.VertexBuffer);
            this.indexBuffer = device.createUploadedBufferFromInts(this.queue, Ref(indices[0]), 3 * 4, NriBufferUsage.IndexBuffer);

            // The low resolution image's texels as they are: nearest, clamped to the edges.
            const sampler = device.createSamplerWithMipFilter(NriFilter.Nearest, NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
            this.sampler = sampler;
            const constantBuffer = device.createHostBuffer(queuedFrameNum * CONST_SLICE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const descriptorPool = device.createDescriptorPool(queuedFrameNum + 1, 1, queuedFrameNum, 1, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!this.vertexBuffer || !this.indexBuffer || !sampler || !constantBuffer || !descriptorPool || !offscreenView) {
                console.log("Cannot create the buffers and descriptors");
                return 0;
            }
            const fullscreenSet = descriptorPool.allocateDescriptorSet(fullscreenLayout, 0, 0);
            this.fullscreenSet = fullscreenSet;
            if (!fullscreenSet) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }
            fullscreenSet.updateDescriptor(0, 0, offscreenView);
            fullscreenSet.updateDescriptor(1, 0, sampler);

            // Queued frames
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const constantView = constantBuffer.createConstantView(i * CONST_SLICE, CONST_SLICE);
                const sceneSet = descriptorPool.allocateDescriptorSet(sceneLayout, 0, 0);
                if (!constantView || !sceneSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                sceneSet.updateDescriptor(0, 0, constantView);
                this.queuedFrames.push(new QueuedFrame(constantView, sceneSet));
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

        // The triangle's pipelines: back faces culled (clockwise triangles are front faces), no depth
        // test; for the low resolution target, without and with conservative rasterization (the sample
        // enlarging the triangle by the device's maximum extra size, Vulkan only). Null if it can't be
        // made.
        createTrianglePipeline(device: NriDevice, layout: NriPipelineLayout, conservative: boolean): NriPipeline | null {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${this.shaders}_triangle_vs.bin`, "triangle_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${this.shaders}_triangle_ps.bin`, "triangle_ps") != 0;
            }
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            desc.addVertexAttribute("COLOR", NriFormat.RGB32_SFLOAT, 12);
            desc.setCullMode(NriCullMode.Back);
            desc.setColor(NriFormat.RGBA8_UNORM, NriColorWrite.RGBA);
            if (conservative) {
                desc.setConservativeRaster(1);
                desc.setConservativeRasterExtraOverestimation(this.hasVulkanProperties ? this.vulkanProperties[1] : 0.0);
            }
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        // Waits for the frame that last used this frame's command allocator (and constants).
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // ApiVulkanSample's mouse handling: dragging with the left button rotates the camera, with the
        // right one zooms, with the middle one pans (unless the overlay has the mouse).
        handleMouse() {
            if (this.imgui) {
                if (NriImgui.wantsMouse() != 0) {
                    return;
                }
            }
            // The sample's dx, dy: the last position minus the new one.
            const dx = -this.sample.getMouseDeltaX();
            const dy = -this.sample.getMouseDeltaY();
            if (this.sample.isButtonPressed(MOUSE_LEFT) != 0) {
                this.cameraRotation[0] += dy * ROTATION_SPEED;
                this.cameraRotation[1] -= dx * ROTATION_SPEED;
            }
            if (this.sample.isButtonPressed(MOUSE_RIGHT) != 0) {
                this.cameraPosition[2] += dy * ZOOM_SPEED;
            }
            if (this.sample.isButtonPressed(MOUSE_MIDDLE) != 0) {
                this.cameraPosition[0] -= dx * PAN_SPEED;
                this.cameraPosition[1] -= dy * PAN_SPEED;
            }
        }

        // The sample's update_uniform_buffers_scene: its camera's matrices, into the queued frame's
        // slice.
        writeConstants(queuedFrameIndex: int) {
            const constantBuffer = this.constantBuffer;
            if (!constantBuffer) {
                return;
            }
            const c = this.constants;
            const projection = samplePerspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR);
            // A "look at" camera: translation * rotation (about x, then y, then z).
            const r = this.cameraRotation;
            let rotationMatrix = multiply(rotation(radians(r[0]), 1.0, 0.0, 0.0), rotation(radians(r[1]), 0.0, 1.0, 0.0));
            rotationMatrix = multiply(rotationMatrix, rotation(radians(r[2]), 0.0, 0.0, 1.0));
            const p = this.cameraPosition;
            const view = multiply(translation(p[0], p[1], p[2]), rotationMatrix);
            for (let i = 0; i < 16; i++) {
                c[CONST_PROJECTION + i] = projection[i];
                c[CONST_MODEL + i] = view[i];
            }
            c[CONST_VIEWPORT_SIZE] = this.width;
            c[CONST_VIEWPORT_SIZE + 1] = this.height;
            c[CONST_LINE_WIDTH] = LINE_WIDTH;
            constantBuffer.write(queuedFrameIndex * CONST_SLICE, Ref(c[0]), CONST_FLOATS * 4);
        }

        // The sample's overlay.
        buildUI() {
            this.sample.imguiNewFrame();
            NriImgui.setNextWindowPos(10.0, 10.0);
            // The sample's title (ApiVulkanSample's default).
            NriImgui.begin("Vulkan Example", 1);
            if (NriImgui.collapsingHeader("Settings", 1) != 0) {
                this.conservativeRasterEnabled = NriImgui.checkbox("Conservative rasterization", this.conservativeRasterEnabled ? 1 : 0) != 0;
            }
            if (NriImgui.collapsingHeader("Device properties", 1) != 0) {
                if (this.hasVulkanProperties) {
                    const p = this.vulkanProperties;
                    NriImgui.text(`maxExtraPrimitiveOverestimationSize: ${formatFloat(p[1])}`);
                    NriImgui.text(`extraPrimitiveOverestimationSizeGranularity: ${formatFloat(p[2])}`);
                    NriImgui.text(`primitiveUnderestimation:  ${yesNo(p[3])}`);
                    NriImgui.text(`conservativePointAndLineRasterization:  ${yesNo(p[4])}`);
                    NriImgui.text(`degenerateTrianglesRasterized: ${yesNo(p[5])}`);
                    NriImgui.text(`degenerateLinesRasterized: ${yesNo(p[6])}`);
                    NriImgui.text(`fullyCoveredFragmentShaderInputVariable: ${yesNo(p[7])}`);
                    NriImgui.text(`conservativeRasterizationPostDepthCoverage: ${yesNo(p[8])}`);
                } else if (this.tier > 0) {
                    NriImgui.text(`ConservativeRasterizationTier: ${this.tier}`);
                }
            }
            NriImgui.end();
            this.sample.imguiRender();
        }

        // First pass: the triangle at low resolution, into the cleared low resolution target, which
        // then goes to the second pass.
        recordOffscreen(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const sceneLayout = this.sceneLayout;
            const pipeline = this.conservativeRasterEnabled ? this.triangleConservativePipeline : this.trianglePipeline;
            const vertexBuffer = this.vertexBuffer;
            const indexBuffer = this.indexBuffer;
            const offscreenColor = this.offscreenColor;
            const offscreenAttachment = this.offscreenAttachment;
            if (!sceneLayout || !pipeline || !vertexBuffer || !indexBuffer || !offscreenColor || !offscreenAttachment) {
                return;
            }
            commandBuffer.textureBarrier(offscreenColor, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            commandBuffer.beginRendering(offscreenAttachment);
            commandBuffer.clearColor(CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 0.0);
            commandBuffer.setViewport(0.0, 0.0, this.offscreenWidth, this.offscreenHeight);
            commandBuffer.setScissor(0, 0, this.offscreenWidth, this.offscreenHeight);
            commandBuffer.setPipelineLayout(sceneLayout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setDescriptorSet(0, queuedFrame.sceneSet);
            commandBuffer.setVertexBuffer(0, vertexBuffer, 0, VERTEX_SIZE);
            commandBuffer.setIndexBuffer(indexBuffer, 0, NriIndexType.UInt32);
            commandBuffer.drawIndexed(3, 1, 0, 0, 0);
            commandBuffer.endRendering();
            commandBuffer.textureBarrier(offscreenColor, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
        }

        // Second pass: the low resolution image over the screen (cleared first), the real triangle's
        // outline over it (between NriCommandBuffer.beginRendering and NriCommandBuffer.endRendering).
        recordScreen(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const sceneLayout = this.sceneLayout;
            const fullscreenLayout = this.fullscreenLayout;
            const fullscreenPipeline = this.fullscreenPipeline;
            const overlayPipeline = this.overlayPipeline;
            const fullscreenSet = this.fullscreenSet;
            const vertexBuffer = this.vertexBuffer;
            if (!sceneLayout || !fullscreenLayout || !fullscreenPipeline || !overlayPipeline || !fullscreenSet || !vertexBuffer) {
                return;
            }
            commandBuffer.clearColor(CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 0.25);
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(fullscreenLayout);
            commandBuffer.setPipeline(fullscreenPipeline);
            commandBuffer.setDescriptorSet(0, fullscreenSet);
            commandBuffer.draw(3, 1, 0, 0);

            commandBuffer.setPipelineLayout(sceneLayout);
            commandBuffer.setPipeline(overlayPipeline);
            commandBuffer.setDescriptorSet(0, queuedFrame.sceneSet);
            commandBuffer.setVertexBuffer(0, vertexBuffer, 0, VERTEX_SIZE);
            commandBuffer.draw(3, 1, 0, 0);
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The low resolution target at the swap chain's size divided by ZOOM_FACTOR, and its views;
        // false on failure. Once the full screen set exists, its texture slot points at the new view.
        createOffscreen(device: NriDevice): boolean {
            this.offscreenWidth = Math.floor(this.width / ZOOM_FACTOR);
            this.offscreenHeight = Math.floor(this.height / ZOOM_FACTOR);
            const offscreenColor = device.createRenderTargetTexture(this.queue, this.offscreenWidth, this.offscreenHeight,
                NriFormat.RGBA8_UNORM);
            this.offscreenColor = offscreenColor;
            if (!offscreenColor) {
                return false;
            }
            this.offscreenAttachment = offscreenColor.createColorAttachmentView(NriFormat.RGBA8_UNORM);
            const offscreenView = offscreenColor.createView(NriFormat.RGBA8_UNORM);
            this.offscreenView = offscreenView;
            const fullscreenSet = this.fullscreenSet;
            if (fullscreenSet) {
                if (offscreenView) {
                    fullscreenSet.updateDescriptor(0, 0, offscreenView);
                }
            }
            return true;
        }

        destroyOffscreen() {
            this.destroyDescriptor(this.offscreenAttachment);
            this.offscreenAttachment = null;
            this.destroyDescriptor(this.offscreenView);
            this.offscreenView = null;
            const offscreenColor = this.offscreenColor;
            if (offscreenColor) {
                offscreenColor.destroy();
            }
            this.offscreenColor = null;
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain and the low resolution target made again at its size, once the
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
            this.destroyOffscreen();
            this.swapChain.recreate();
            this.sizeToSwapChain();
            this.createOffscreen(device);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            const descriptorPool = this.descriptorPool;
            if (!descriptorPool) {
                return;
            }
            if (this.imgui) {
                this.buildUI();
            }
            if (!this.test) {
                this.handleMouse();
            }
            this.writeConstants(queuedFrameIndex);

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: the low resolution pass; then the swap chain texture's, the overlay over it.
                commandBuffer.begin();
                commandBuffer.setDescriptorPool(descriptorPool);
                this.recordOffscreen(commandBuffer, queuedFrame);
                if (this.imgui) {
                    this.sample.copyImguiData(commandBuffer);
                }
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                this.recordScreen(commandBuffer, queuedFrame);
                if (this.imgui) {
                    this.sample.drawImgui(commandBuffer, this.viewFormat);
                }
                commandBuffer.endRendering();

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
                    queuedFrame.constantView.destroy();
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                this.destroyDescriptor(this.sampler);
                this.destroyOffscreen();
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.indexBuffer);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.trianglePipeline);
                this.destroyPipeline(this.triangleConservativePipeline);
                this.destroyPipeline(this.overlayPipeline);
                this.destroyPipeline(this.fullscreenPipeline);
                this.destroyLayout(this.sceneLayout);
                this.destroyLayout(this.fullscreenLayout);
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

        destroyLayout(layout: NriPipelineLayout | null) {
            if (layout) {
                layout.destroy();
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const conservativeRasterization = new ConservativeRasterization(sample);
        // -noconservative: start with conservative rasterization off; -noUI: no overlay.
        sample.addExampleOption("-noconservative");
        sample.addExampleOption("-noUI");
        sample.useImgui();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-noconservative") {
                conservativeRasterization.conservativeRasterEnabled = false;
            } else if (arg == "-noUI") {
                conservativeRasterization.noUI = true;
            }
        }
        return conservativeRasterization.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return ConservativeRasterizationNri.main(argc, argv);
}

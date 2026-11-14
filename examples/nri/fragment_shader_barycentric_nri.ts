/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { multiply, rotation, translation, radians, samplePerspective } from "../../core/matrix";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriGltfMesh, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace FragmentShaderBarycentricNri {
    // fragment_shader_barycentric, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework
    // instead of Donut and NVRHI: the same shaders (fragment_shader_barycentric.hlsl's), models (read
    // as Donut's loadGltfMesh reads them) and textures, through the NRI calls
    // core/nri/nri_interop.d.ts binds, with NRIFramework's ImGui for the sample's overlay. This
    // example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no barycentrics in pixel shaders,
    // or no shaders for the graphics API (D3D11).
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Fragment Shader Barycentric";

    // The sample's models and textures (Vulkan-Samples' assets), the KTX textures converted to DDS
    // at build time (see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const SKYBOX_PATH = "media/fragment_shader_barycentric/cube.gltf";
    const OBJECT_PATH = "media/fragment_shader_barycentric/textured_unit_cube.gltf";
    const ENVMAP_PATH = "media/fragment_shader_barycentric/uffizi_rgba16f_cube.dds";
    const CUBE_TEXTURE_PATH = "media/fragment_shader_barycentric/checkerboard_rgba.dds";

    // NriDevice.loadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;

    // struct UBO { float4x4 projection, modelview; }, as f32 offsets; a queued frame's in a 256-byte
    // slice of the constant buffer (D3D12 constant buffer views' alignment).
    const CONST_PROJECTION = 0;
    const CONST_MODELVIEW = 16;
    const CONST_FLOATS = 32;
    const CONST_STRIDE = 256;

    const EFFECT_NAMES = "Color interpolation|Perspective vs non-perspective|Wireframe|Interpolate to mass center|Barycoord texture";
    const EFFECT_COUNT = 5;

    // The sample's camera: a "look at" camera at (0, 1, -6), 60 degrees vertically, reversed depth
    // from 256 to 0.1 (glm::perspective with near and far swapped).
    const CAMERA_POSITION = [0.0, 1.0, -6.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;
    // ApiVulkanSample's mouse controls: degrees per pixel dragged with the left button, zoom per
    // pixel with the right one, panning per pixel with the middle one.
    const ROTATION_SPEED = 1.0;
    const ZOOM_SPEED = 0.005;
    const PAN_SPEED = 0.01;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // A frame in flight's own data: its descriptor sets (the
    // skybox's and the object's: the UBO's slice, a texture, the sampler) with the UBO's view.
    class QueuedFrame {
        constructor(public skyboxSet: NriDescriptorSet | null, public objectSet: NriDescriptorSet | null,
            public constantBufferView: NriDescriptor | null) {
        }
    }

    // -test: checks the last frame, read back, as the Donut example does: the street skybox fills it
    // (95% or more of the pixels not near black), and the cube in the middle is colored by its
    // barycentric coordinates (4% to 12% of the frame colored).
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const middle = pixels[(height / 2) * width + width / 2];
        if (!(((middle >> 8) & 0xFF) > 120 || ((middle >> 16) & 0xFF) > 120 || (middle & 0xFF) > 120)) {
            return "the middle isn't the colored cube";
        }
        let dark = 0;
        let colored = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r <= 20 && g <= 20 && b <= 20) {
                dark++;
            }
            const high = Math.max(r, Math.max(g, b));
            const low = Math.min(r, Math.min(g, b));
            if (high - low >= 61) {
                colored++;
            }
        }
        const total = width * height;
        const lit = 100.0 * (total - dark) / total;
        console.log(`Lit: ${lit}% (${total - dark} of ${total} pixels)`);
        if (lit < 95.0) {
            return `Lit: ${lit}% of the pixels, not 95% to 100%`;
        }
        const coloredPercent = 100.0 * colored / total;
        console.log(`Colored: ${coloredPercent}% (${colored} of ${total} pixels)`);
        if (coloredPercent < 4.0 || coloredPercent > 12.0) {
            return `Colored: ${coloredPercent}% of the pixels, not 4% to 12%`;
        }
        return "";
    }

    // Port of Vulkan-Samples' fragment_shader_barycentric (as examples/fragment_shader_barycentric.ts
    // ports it) to NRI: a cube in front of a skybox, its pixel shader reading the pixel's barycentric
    // coordinates in its triangle (perspective-correct and not) and the colors of the triangle's three
    // vertices, uninterpolated. The effects menu picks what it draws with them: the colors
    // interpolated by hand, the difference of the two barycentrics, a wireframe, the color of the
    // nearest vertex, a texture lookup. Drawn straight into the sRGB swap chain view, where the Donut
    // example draws into an sRGB color buffer and blits it; neither tests depth.
    class FragmentShaderBarycentric {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        // The swap chain textures' format and their views' (sRGB).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private viewFormat: NriFormat = NriFormat.Unknown;
        private pipelineLayout: NriPipelineLayout | null = null;
        private skyboxPipeline: NriPipeline | null = null;
        private objectPipeline: NriPipeline | null = null;
        private skybox: NriGltfMesh | null = null;
        private object: NriGltfMesh | null = null;
        private envmap: NriTexture | null = null;
        private envmapView: NriDescriptor | null = null;
        private cubeTexture: NriTexture | null = null;
        private cubeTextureView: NriDescriptor | null = null;
        private sampler: NriDescriptor | null = null;
        private constantBuffer: NriBuffer | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private imgui: boolean = false;
        // The swap chain's size: the window's when it was (re)created.
        private width: int = 0;
        private height: int = 0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        // The sample's camera: rotation (degrees about x, y, z) and position; the mouse as it last
        // saw it.
        private cameraRotation: number[] = [0.0, 0.0, 0.0];
        private cameraPosition: number[] = [CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]];
        private buttons: boolean[] = [false, false, false];
        private mouseX: number = 0.0;
        private mouseY: number = 0.0;

        // The sample's setting (-effect <0..4>); -noUI: no overlay.
        selectedEffect: int = 0;
        noUI: boolean = false;

        // Upload buffers: the UBO, and the push constants (the effect).
        private constants: f32[] = [];
        private pushConstants: f32[] = [0.0];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
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

            // On a wrapper of its own: the callbacks Nri_RunSample runs may overwrite this.sample.
            let result = new NriSample(this.sample.handle).run(argc, argv, WINDOW_TITLE, TEST_FRAMES);
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

            // Swap chain: rendered through sRGB views, as the sample's sRGB color buffer (which the
            // Donut example blits into its back buffer).
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;

            // Shader model 6.1's barycentrics only (as the Donut example's shaders, DXIL and SPIR-V).
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "No D3D11 shaders (fragment_shader_barycentric.hlsl needs shader model 6.1)";
                return 0;
            }
            if (device.isFeatureSupported(NriFeature.Barycentrics) == 0) {
                this.unsupportedReason = "This example needs barycentrics in pixel shaders (D3D12 shader model 6.1 or Vulkan's VK_KHR_fragment_shader_barycentric)";
                return 0;
            }

            // The models and textures: the environment map as is, the checkerboard as sRGB (KTX 1
            // files have no color space: the framework takes color textures as sRGB).
            this.skybox = device.loadGltfMesh(this.queue, SKYBOX_PATH);
            this.object = device.loadGltfMesh(this.queue, OBJECT_PATH);
            const envmap = device.loadDdsTexture(this.queue, ENVMAP_PATH, 0);
            const cubeTexture = device.loadDdsTexture(this.queue, CUBE_TEXTURE_PATH, 1);
            this.envmap = envmap;
            this.cubeTexture = cubeTexture;
            if (!this.modelsLoaded() || !envmap || !cubeTexture) {
                console.log("Cannot load the models and textures: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            const envmapView = envmap.createCubeView(NriFormat.RGBA16_SFLOAT);
            const cubeTextureView = cubeTexture.createView(NriFormat.RGBA8_SRGB);
            this.envmapView = envmapView;
            this.cubeTextureView = cubeTextureView;
            // The framework's texture samplers: trilinear, wrapped, anisotropy 16 (Donut's
            // AnisotropicWrap).
            const sampler = device.createSamplerWithMipFilter(NriFilter.Linear, NriFilter.Linear, NriAddressMode.Repeat, 16);
            this.sampler = sampler;

            // The layout: the sample's descriptor set (the UBO at b0, a texture at t0, the sampler at
            // s0) and push constants (the effect, at b1: root constants).
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.addRootConstants(1, 4, NriStage.Pixel);
            this.pipelineLayout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
            const pipelineLayout = this.pipelineLayout;
            if (!pipelineLayout || !sampler) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The sample's pipelines: fragment_shader_barycentric.hlsl's shaders, as compiled for the
            // Donut example; no depth test or writes (the skybox is drawn first), counter-clockwise
            // front faces; back faces culled for the skybox, front faces for the object.
            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/fragment_shader_barycentric/${folder}/fragment_shader_barycentric`;
            this.skyboxPipeline = this.createPipeline(device, pipelineLayout, shaders, "skybox", NriCullMode.Back);
            this.objectPipeline = this.createPipeline(device, pipelineLayout, shaders, "object", NriCullMode.Front);
            if (!this.skyboxPipeline || !this.objectPipeline) {
                console.log("Cannot load the fragment shader barycentric shaders");
                return 0;
            }

            // The UBO, a queued frame's each; a queued frame's descriptor sets.
            const constantBuffer = device.createHostBuffer(queuedFrameNum * CONST_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const descriptorPool = device.createDescriptorPool(2 * queuedFrameNum, 2 * queuedFrameNum, 2 * queuedFrameNum,
                2 * queuedFrameNum, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!constantBuffer || !descriptorPool) {
                console.log("Cannot create the constant buffer");
                return 0;
            }
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const constantBufferView = constantBuffer.createConstantView(i * CONST_STRIDE, CONST_STRIDE);
                const skyboxSet = descriptorPool.allocateDescriptorSet(pipelineLayout, 0, 0);
                const objectSet = descriptorPool.allocateDescriptorSet(pipelineLayout, 0, 0);
                this.queuedFrames.push(new QueuedFrame(skyboxSet, objectSet,
                    constantBufferView));
                if (!constantBufferView || !skyboxSet || !objectSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                skyboxSet.updateDescriptor(0, 0, constantBufferView);
                skyboxSet.updateDescriptor(1, 0, envmapView);
                skyboxSet.updateDescriptor(2, 0, sampler);
                objectSet.updateDescriptor(0, 0, constantBufferView);
                objectSet.updateDescriptor(1, 0, cubeTextureView);
                objectSet.updateDescriptor(2, 0, sampler);
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

        // Both models were loaded.
        modelsLoaded(): boolean {
            if (!this.skybox) {
                return false;
            }
            return this.object ? true : false;
        }

        // A pipeline of the shaders <name>_vs and <name>_ps: the position from the models' vertices,
        // no depth, counter-clockwise front faces, cullMode culled.
        createPipeline(device: NriDevice, pipelineLayout: NriPipelineLayout, shaders: string, name: string,
            cullMode: NriCullMode) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_${name}_vs.bin`, `${name}_vs`) != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_${name}_ps.bin`, `${name}_ps`) != 0;
            }
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            desc.setCullMode(cullMode);
            desc.setFrontCounterClockwise(1);
            desc.setColor(this.viewFormat, NriColorWrite.RGBA);
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

        // ApiVulkanSample's mouse handling, unless the overlay has the mouse: dragging with the left
        // button rotates the camera, with the right one zooms, with the middle one pans.
        handleMouse() {
            const overlay = this.imgui && NriImgui.wantsMouse() != 0;
            for (let button = 0; button < 3; button++) {
                const pressed = this.sample.isButtonPressed(button) != 0;
                if (!pressed || !overlay) {
                    this.buttons[button] = pressed;
                }
            }
            const x = this.sample.getMouseX();
            const y = this.sample.getMouseY();
            const dx = this.mouseX - x;
            const dy = this.mouseY - y;
            if (this.buttons[0]) {
                this.cameraRotation[0] += dy * ROTATION_SPEED;
                this.cameraRotation[1] -= dx * ROTATION_SPEED;
            }
            if (this.buttons[1]) {
                this.cameraPosition[2] += dy * ZOOM_SPEED;
            }
            if (this.buttons[2]) {
                this.cameraPosition[0] -= dx * PAN_SPEED;
                this.cameraPosition[1] -= dy * PAN_SPEED;
            }
            this.mouseX = x;
            this.mouseY = y;
        }

        // The sample's overlay (its title, ApiVulkanSample's default).
        buildUI() {
            this.sample.imguiNewFrame();
            NriImgui.setNextWindowPos(10.0, 10.0);
            NriImgui.begin("Vulkan Example", 1);
            if (NriImgui.collapsingHeader("Settings", 1) != 0) {
                this.selectedEffect = NriImgui.combo("Effects", this.selectedEffect, EFFECT_NAMES);
            }
            NriImgui.end();
            this.sample.imguiRender();
        }

        // The sample's update_uniform_buffers: its camera's matrices, into this frame's slice.
        updateConstants(constantBuffer: NriBuffer, offset: int) {
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
                c[CONST_MODELVIEW + i] = view[i];
            }
            constantBuffer.write(offset, Ref(c[0]), CONST_FLOATS * 4);
        }

        // A model with its pipeline and descriptor set, the effect in the push constants.
        drawModel(commandBuffer: NriCommandBuffer, pipeline: NriPipeline | null, set: NriDescriptorSet | null,
            mesh: NriGltfMesh | null) {
            if (!pipeline || !set || !mesh) {
                return;
            }
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setDescriptorSet(0, set);
            commandBuffer.setRootConstants(0, Ref(this.pushConstants[0]), 4);
            commandBuffer.setVertexBuffer(0, mesh.getVertexBuffer(), 0, VERTEX_SIZE);
            commandBuffer.setIndexBuffer(mesh.getIndexBuffer(), 0, NriIndexType.UInt32);
            commandBuffer.drawIndexed(mesh.getIndexCount(), 1, 0, 0, 0);
        }

        // The skybox, then the object with the selected effect (between NriCommandBuffer.beginRendering and
        // NriCommandBuffer.endRendering).
        recordDraw(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame, frameOffset: int) {
            const pipelineLayout = this.pipelineLayout;
            const descriptorPool = this.descriptorPool;
            const constantBuffer = this.constantBuffer;
            if (!pipelineLayout || !descriptorPool || !constantBuffer) {
                return;
            }
            this.updateConstants(constantBuffer, frameOffset);
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(pipelineLayout);

            // skybox
            this.drawModel(commandBuffer, this.skyboxPipeline, queuedFrame.skyboxSet, this.skybox);

            // object, with the selected effect in its push constants
            Nri.storeInt32(Ref(this.pushConstants[0]), this.selectedEffect);
            this.drawModel(commandBuffer, this.objectPipeline, queuedFrame.objectSet, this.object);
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain made again at its size, once the
        // GPU is done with the old ones.
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
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.handleMouse();

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: cleared to transparent black, the skybox and the object, the overlay over
                // them.
                commandBuffer.begin();
                if (this.imgui) {
                    this.sample.copyImguiData(commandBuffer);
                }
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
                this.recordDraw(commandBuffer, queuedFrame, queuedFrameIndex * CONST_STRIDE);
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
                    this.destroyDescriptor(queuedFrame.constantBufferView);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                this.destroyDescriptor(this.envmapView);
                this.destroyDescriptor(this.cubeTextureView);
                this.destroyDescriptor(this.sampler);
                this.destroyTexture(this.envmap);
                this.destroyTexture(this.cubeTexture);
                this.destroyMesh(this.skybox);
                this.destroyMesh(this.object);
                const constantBuffer = this.constantBuffer;
                if (constantBuffer) {
                    constantBuffer.destroy();
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    readbackBuffer.destroy();
                }
                this.destroyPipeline(this.skyboxPipeline);
                this.destroyPipeline(this.objectPipeline);
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

        destroyTexture(texture: NriTexture | null) {
            if (texture) {
                texture.destroy();
            }
        }

        destroyMesh(mesh: NriGltfMesh | null) {
            if (mesh) {
                mesh.destroy();
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
        const barycentric = new FragmentShaderBarycentric(sample);
        // -effect <0..4>: the effect selected at start; -noUI: no overlay.
        sample.addExampleOptionWithValues("-effect", 1);
        sample.addExampleOption("-noUI");
        sample.useImgui();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-effect" && i + 1 < argc) {
                i++;
                barycentric.selectedEffect = Math.min(Math.max(parseInt(Nri.getArg(argc, argv, i)), 0), EFFECT_COUNT - 1);
            } else if (arg == "-noUI") {
                barycentric.noUI = true;
            }
        }
        return barycentric.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return FragmentShaderBarycentricNri.main(argc, argv);
}

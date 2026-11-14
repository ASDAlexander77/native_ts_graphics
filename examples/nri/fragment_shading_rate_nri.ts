/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { identity, multiply, rotate, radians, perspective } from "../../core/matrix";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriGltfMesh, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace FragmentShadingRateNri {
    // fragment_shading_rate, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead
    // of Donut and NVRHI: the same shaders (fragment_shading_rate.hlsl's), models (read as Donut's
    // loadGltfMesh reads them) and textures, through the NRI calls core/nri/nri_interop.d.ts binds,
    // with NRIFramework's ImGui for the sample's overlay. This example creates everything it runs,
    // and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no variable rate shading with
    // shading rate attachments, or no shaders for the graphics API (D3D11).
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Fragment Shading Rate";

    // The sample's models and textures (Vulkan-Samples' assets), the KTX textures converted to DDS
    // at build time (see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const MEDIA_DIR = "media/fragment_shading_rate/";
    const SKYSPHERE_PATH = MEDIA_DIR + "geosphere.gltf";
    const SCENE_PATH = MEDIA_DIR + "textured_unit_cube.gltf";
    const SKYSPHERE_TEXTURE_PATH = MEDIA_DIR + "skysphere_rgba.dds";
    const SCENE_TEXTURE_PATH = MEDIA_DIR + "metalplate01_rgba.dds";

    // NriDevice.loadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;

    // struct UBOScene { float4x4 projection, modelview, skysphere_modelview; int color_shading_rate; },
    // padded, as f32 offsets; a queued frame's in a 256-byte slice of the constant buffer (D3D12
    // constant buffer views' alignment).
    const UBO_PROJECTION = 0;
    const UBO_MODELVIEW = 16;
    const UBO_SKYSPHERE_MODELVIEW = 32;
    const UBO_COLOR_SHADING_RATE = 48;
    const UBO_FLOATS = 52;
    const UBO_STRIDE = 256;
    // The push constants (root constants at b1): float4 offset; int object_type.
    const PUSH_FLOATS = 5;
    const PUSH_SIZE = PUSH_FLOATS * 4;
    const OBJECT_SKYSPHERE = 0;
    const OBJECT_CUBE = 1;

    // The three cubes' offsets.
    const MESH_OFFSETS = [-2.5, 0.0, 0.0, 0.0, 0.0, 0.0, 2.5, 0.0, 0.0];

    // The sample's first person camera at (0, 0, -4) (the view's translation), a 60 degree vertical
    // field of view, depth reversed (near 256, far 0.1, as the sample passes them).
    const CAMERA_POSITION = [0.0, 0.0, -4.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;

    // The shading rate image's rings: from 8% of the image's size out, 25% split between the
    // device's rates (the finest innermost); 4 x 4 beyond.
    const RING_START = 8.0;
    const RING_SPAN = 25.0;
    const OUTER_RATE = (4 >> 1) | (4 << 1);

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // A frame in flight's own data: its descriptor set (the UBO's
    // slice, the two textures and their samplers) with the UBO's view.
    class QueuedFrame {
        constructor(public descriptorSet: NriDescriptorSet | null, public constantBufferView: NriDescriptor | null) {
        }
    }

    // -test: checks the last frame, read back, as the Donut example does: the textured cubes over the
    // blue sky fill it (95% or more of the pixels not near black), the texture's cyan glow in the
    // middle, the sky 4% to 10% blue.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const middle = pixels[(height / 2) * width + width / 2];
        if (!(((middle >> 16) & 0xFF) > 200 && ((middle >> 8) & 0xFF) > 180)) {
            return "the middle isn't the texture's glow";
        }
        let dark = 0;
        let blue = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r <= 20 && g <= 20 && b <= 20) {
                dark++;
            }
            if (r <= 89 && g <= 119 && b >= 121) {
                blue++;
            }
        }
        const total = width * height;
        const lit = 100.0 * (total - dark) / total;
        console.log(`Lit: ${lit}% (${total - dark} of ${total} pixels)`);
        if (lit < 95.0) {
            return `Lit: ${lit}% of the pixels, not 95% to 100%`;
        }
        const bluePercent = 100.0 * blue / total;
        console.log(`Blue: ${bluePercent}% (${blue} of ${total} pixels)`);
        if (bluePercent < 4.0 || bluePercent > 10.0) {
            return `Blue: ${bluePercent}% of the pixels, not 4% to 10%`;
        }
        return "";
    }

    // Port of Vulkan-Samples' fragment_shading_rate (as examples/fragment_shading_rate.ts ports it)
    // to NRI: a sky sphere and three textured, lit cubes drawn with a shading rate attachment (a
    // texel per tile of pixels) made once on the CPU: rings around the center, from the full rate in
    // the middle to coarser rates outwards. The UI switches the attachment off (the full rate
    // everywhere) and shows the rates as shades of the color's red. Drawn straight into the sRGB swap
    // chain view, as the Donut example draws into its back buffer; the overlay in a pass of its own
    // (its pipeline has no shading rate). D3D12 (tier 2) or Vulkan (VK_KHR_fragment_shading_rate).
    class FragmentShadingRate {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        // The swap chain textures' format (its views' are viewFormat).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private viewFormat: NriFormat = NriFormat.Unknown;
        private pipelineLayout: NriPipelineLayout | null = null;
        private skyspherePipeline: NriPipeline | null = null;
        private cubePipeline: NriPipeline | null = null;
        private skysphereMesh: NriGltfMesh | null = null;
        private sceneMesh: NriGltfMesh | null = null;
        private skysphereTexture: NriTexture | null = null;
        private skysphereTextureView: NriDescriptor | null = null;
        private sceneTexture: NriTexture | null = null;
        private sceneTextureView: NriDescriptor | null = null;
        private sampler: NriDescriptor | null = null;
        private depthTexture: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
        private shadingRateTexture: NriTexture | null = null;
        private shadingRateAttachment: NriDescriptor | null = null;
        private constantBuffer: NriBuffer | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private imgui: boolean = false;
        // The swap chain's size: the window's when it was (re)created.
        private width: int = 0;
        private height: int = 0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        // The device's shading rates (width, height pairs, largest first) and the shading rate
        // attachment's tile size.
        private rates: int[] = [];
        private rateCount: int = 0;
        private tileSize: int = 1;

        // The sample's camera (the framework's vkb::Camera, first person type): rotation (degrees
        // about x, y, z) and position; the mouse as it last saw it.
        private cameraRotation: number[] = [0.0, 0.0, 0.0];
        private cameraPosition: number[] = [CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]];
        private buttons: boolean[] = [false, false, false];
        private mouseX: number = 0.0;
        private mouseY: number = 0.0;

        // The sample's settings (-noattachment, -color, -nosky); -noUI: no overlay.
        enableAttachmentShadingRate: boolean = true;
        colorShadingRate: boolean = false;
        displaySkySphere: boolean = true;
        noUI: boolean = false;

        // Upload buffers: the UBO, and the push constants.
        private ubo: f32[] = [];
        private push: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
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
            for (let i = 0; i < 32; i++) {
                this.rates.push(0);
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

            // Swap chain: rendered through sRGB views, as the Donut example's sRGB back buffer.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.viewFormat;

            // SV_ShadingRate is shader model 6.4's (the Donut example's shaders: DXIL and SPIR-V).
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "No D3D11 shaders (fragment_shading_rate.hlsl needs shader model 6.4)";
                return 0;
            }
            if (device.isFeatureSupported(NriFeature.VariableRateShading) == 0) {
                this.unsupportedReason = "The graphics device has no variable rate shading (D3D12 tier 2 or Vulkan's VK_KHR_fragment_shading_rate)";
                return 0;
            }
            this.rateCount = device.getFragmentShadingRates(Ref(this.rates[0]));
            this.tileSize = device.getShadingRateTileSize();
            if (this.rateCount == 0 || this.tileSize == 0) {
                this.unsupportedReason = "The graphics device has no variable rate shading with shading rate images";
                return 0;
            }

            // The models and textures, the textures as sRGB (as the framework loads KTX 1 color
            // textures).
            this.skysphereMesh = device.loadGltfMesh(this.queue, SKYSPHERE_PATH);
            this.sceneMesh = device.loadGltfMesh(this.queue, SCENE_PATH);
            const skysphereTexture = device.loadDdsTexture(this.queue, SKYSPHERE_TEXTURE_PATH, 1);
            const sceneTexture = device.loadDdsTexture(this.queue, SCENE_TEXTURE_PATH, 1);
            this.skysphereTexture = skysphereTexture;
            this.sceneTexture = sceneTexture;
            if (!this.modelsLoaded() || !skysphereTexture || !sceneTexture) {
                console.log("Cannot load the models and textures: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            const skysphereTextureView = skysphereTexture.createView(NriFormat.RGBA8_SRGB);
            const sceneTextureView = sceneTexture.createView(NriFormat.RGBA8_SRGB);
            this.skysphereTextureView = skysphereTextureView;
            this.sceneTextureView = sceneTextureView;
            // ApiVulkanSample::load_texture's sampler: trilinear, repeating, anisotropic at the
            // device's most.
            const sampler = device.createSamplerWithMipFilter(NriFilter.Linear, NriFilter.Linear, NriAddressMode.Repeat,
                device.getMaxSamplerAnisotropy());
            this.sampler = sampler;

            // The targets (for the window's size, made again when it is resized): the depth buffer and
            // the shading rate attachment.
            if (!this.createSizeTargets(device)) {
                console.log("Cannot create the depth buffer and the shading rate attachment");
                return 0;
            }

            // The layout: the sample's descriptor set (the UBO at b0, the sky sphere's texture and
            // sampler at t0 and s0, the cubes' at t1 and s1) and push constants (b1: root constants).
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 2, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 2, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.addRootConstants(1, PUSH_SIZE, NriStage.VertexPixel);
            this.pipelineLayout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
            const pipelineLayout = this.pipelineLayout;
            if (!pipelineLayout || !sampler) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The sample's pipelines: the sky sphere without depth, back faces culled; the cubes
            // depth tested (greater: reversed) and written, front faces culled; counter-clockwise
            // front faces; their shading rates set with each pass.
            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/fragment_shading_rate/${folder}/fragment_shading_rate`;
            this.skyspherePipeline = this.createPipeline(device, pipelineLayout, shaders, false);
            this.cubePipeline = this.createPipeline(device, pipelineLayout, shaders, true);
            if (!this.skyspherePipeline || !this.cubePipeline) {
                console.log("Cannot load the fragment shading rate shaders");
                return 0;
            }

            // The UBO, a queued frame's each; a queued frame's descriptor set.
            const constantBuffer = device.createHostBuffer(queuedFrameNum * UBO_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const descriptorPool = device.createDescriptorPool(queuedFrameNum, 2 * queuedFrameNum, queuedFrameNum,
                2 * queuedFrameNum, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!constantBuffer || !descriptorPool) {
                console.log("Cannot create the constant buffer");
                return 0;
            }
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const constantBufferView = constantBuffer.createConstantView(i * UBO_STRIDE, UBO_STRIDE);
                const descriptorSet = descriptorPool.allocateDescriptorSet(pipelineLayout, 0, 0);
                this.queuedFrames.push(new QueuedFrame(descriptorSet,
                    constantBufferView));
                if (!constantBufferView || !descriptorSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                descriptorSet.updateDescriptor(0, 0, constantBufferView);
                descriptorSet.updateDescriptor(1, 0, skysphereTextureView);
                descriptorSet.updateDescriptor(1, 1, sceneTextureView);
                descriptorSet.updateDescriptor(2, 0, sampler);
                descriptorSet.updateDescriptor(2, 1, sampler);
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
            if (!this.skysphereMesh) {
                return false;
            }
            return this.sceneMesh ? true : false;
        }

        // The sample's create_shading_rate_attachment: per texel, the rate of the first ring (by
        // distance from the center, in percent of the image's size) it lies in. The rings take the
        // device's rates but its first (largest), finest innermost; the rate codes are the sample's,
        // (width >> 1) | (height << 1). In float32, as the sample computes.
        shadingRatePattern(width: int, height: int) {
            const keys: number[] = [];
            const codes: int[] = [];
            const range = Math.fround(RING_SPAN / this.rateCount);
            let current = Math.fround(RING_START);
            for (let i = this.rateCount - 1; i > 0; i--) {
                const w = this.rates[i * 2];
                const h = this.rates[i * 2 + 1];
                const rateV = w == 1 ? 0 : (w >> 1);
                const rateH = h == 1 ? 0 : (h << 1);
                keys.push(current);
                codes.push(rateV | rateH);
                current = Math.fround(current + range);
            }
            // The texels, 4 to an int (little-endian bytes).
            const packed: int[] = [];
            for (let i = 0; i < Math.floor((width * height + 3) / 4); i++) {
                packed.push(0);
            }
            const halfWidth = Math.fround(width / 2.0);
            const halfHeight = Math.fround(height / 2.0);
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const deltaX = Math.fround(Math.fround(Math.fround(halfWidth - x) / width) * 100.0);
                    const deltaY = Math.fround(Math.fround(Math.fround(halfHeight - y) / height) * 100.0);
                    const dist = Math.fround(Math.sqrt(Math.fround(Math.fround(deltaX * deltaX) + Math.fround(deltaY * deltaY))));
                    let code = OUTER_RATE;
                    for (let k = 0; k < keys.length; k++) {
                        if (dist < keys[k]) {
                            code = codes[k];
                            break;
                        }
                    }
                    const index = y * width + x;
                    packed[index >> 2] |= code << ((index & 3) * 8);
                }
            }
            return packed;
        }

        // A pipeline of scene_vs and scene_ps with variable rate shading: the sky sphere's (cube
        // false) or the cubes'.
        createPipeline(device: NriDevice, pipelineLayout: NriPipelineLayout, shaders: string, cube: boolean) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_scene_vs.bin`, "scene_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_scene_ps.bin`, "scene_ps") != 0;
            }
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            desc.addVertexAttribute("NORMAL", NriFormat.RGB32_SFLOAT, 12);
            desc.addVertexAttribute("TEXCOORD", NriFormat.RG32_SFLOAT, 24);
            desc.setCullMode(cube ? NriCullMode.Front : NriCullMode.Back);
            desc.setFrontCounterClockwise(1);
            desc.setColor(this.viewFormat, NriColorWrite.RGBA);
            desc.setDepth(NriFormat.D32_SFLOAT, cube ? NriCompareOp.Greater : NriCompareOp.None, cube ? 1 : 0, 0);
            desc.setShadingRate(1);
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

        // ApiVulkanSample's mouse handling (handle_mouse_move, speeds 1), unless the overlay has the
        // mouse: dragging with the left button turns the camera, with the right one zooms, with the
        // middle one pans.
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
            const dx = Math.floor(this.mouseX) - Math.floor(x);
            const dy = Math.floor(this.mouseY) - Math.floor(y);
            if (this.buttons[0]) {
                this.cameraRotation[0] += dy;
                this.cameraRotation[1] -= dx;
            }
            if (this.buttons[1]) {
                this.cameraPosition[2] += dy * 0.005;
            }
            if (this.buttons[2]) {
                this.cameraPosition[0] -= dx * 0.01;
                this.cameraPosition[1] -= dy * 0.01;
            }
            this.mouseX = x;
            this.mouseY = y;
        }

        // The sample's overlay.
        buildUI() {
            this.sample.imguiNewFrame();
            NriImgui.setNextWindowPos(10.0, 10.0);
            NriImgui.begin("Options", 1);
            if (NriImgui.collapsingHeader("Settings", 1) != 0) {
                this.enableAttachmentShadingRate = NriImgui.checkbox("Enable attachment shading rate",
                    this.enableAttachmentShadingRate ? 1 : 0) != 0;
                this.colorShadingRate = NriImgui.checkbox("Color shading rates", this.colorShadingRate ? 1 : 0) != 0;
                this.displaySkySphere = NriImgui.checkbox("skysphere", this.displaySkySphere ? 1 : 0) != 0;
            }
            NriImgui.end();
            this.sample.imguiRender();
        }

        // The sample's update_uniform_buffers: its projection (clip y negated, as the Donut example
        // gives it) and view (vkb::Camera::update_view_matrix: rotations around x, y, z, then
        // translate(position)), into this frame's slice.
        updateConstants(constantBuffer: NriBuffer, offset: int) {
            const projection = perspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR);
            let r = identity();
            r = rotate(r, radians(this.cameraRotation[0]), 1.0, 0.0, 0.0);
            r = rotate(r, radians(this.cameraRotation[1]), 0.0, 1.0, 0.0);
            r = rotate(r, radians(this.cameraRotation[2]), 0.0, 0.0, 1.0);
            const t = identity();
            t[12] = this.cameraPosition[0];
            t[13] = this.cameraPosition[1];
            t[14] = this.cameraPosition[2];
            const view = multiply(r, t);
            const u = this.ubo;
            for (let i = 0; i < 16; i++) {
                u[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                u[UBO_MODELVIEW + i] = view[i];
                u[UBO_SKYSPHERE_MODELVIEW + i] = view[i];
            }
            Nri.storeInt32(Ref(u[UBO_COLOR_SHADING_RATE]), this.colorShadingRate ? 1 : 0);
            constantBuffer.write(offset, Ref(u[0]), UBO_FLOATS * 4);
        }

        // The push constants: an offset and the object's kind.
        setPush(commandBuffer: NriCommandBuffer, x: number, y: number, z: number, objectType: int) {
            this.push[0] = x;
            this.push[1] = y;
            this.push[2] = z;
            this.push[3] = 0.0;
            Nri.storeInt32(Ref(this.push[4]), objectType);
            commandBuffer.setRootConstants(0, Ref(this.push[0]), PUSH_SIZE);
        }

        // A mesh's buffers, bound.
        setMesh(commandBuffer: NriCommandBuffer, mesh: NriGltfMesh) {
            commandBuffer.setVertexBuffer(0, mesh.getVertexBuffer(), 0, VERTEX_SIZE);
            commandBuffer.setIndexBuffer(mesh.getIndexBuffer(), 0, NriIndexType.UInt32);
        }

        // The sample's build_command_buffers (between NriCommandBuffer.beginRenderingWithShadingRate and
        // NriCommandBuffer.endRendering): the sky sphere (if shown) and the three cubes, each draw's rate 1 x 1,
        // then the attachment's (REPLACE: NVRHI's Override) or kept (KEEP: Passthrough).
        recordDraw(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame, frameOffset: int) {
            const pipelineLayout = this.pipelineLayout;
            const descriptorPool = this.descriptorPool;
            const constantBuffer = this.constantBuffer;
            const set = queuedFrame.descriptorSet;
            const skysphereMesh = this.skysphereMesh;
            const sceneMesh = this.sceneMesh;
            const skyspherePipeline = this.skyspherePipeline;
            const cubePipeline = this.cubePipeline;
            if (!pipelineLayout || !descriptorPool || !constantBuffer || !set || !skysphereMesh || !sceneMesh || !skyspherePipeline
                || !cubePipeline) {
                return;
            }
            this.updateConstants(constantBuffer, frameOffset);
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(pipelineLayout);
            const attachmentCombiner = this.enableAttachmentShadingRate ? NriShadingRateCombiner.Replace : NriShadingRateCombiner.Keep;

            if (this.displaySkySphere) {
                commandBuffer.setPipeline(skyspherePipeline);
                commandBuffer.setShadingRate(NriShadingRate.Rate1x1, NriShadingRateCombiner.Keep, attachmentCombiner);
                commandBuffer.setDescriptorSet(0, set);
                this.setMesh(commandBuffer, skysphereMesh);
                this.setPush(commandBuffer, 0.0, 0.0, 0.0, OBJECT_SKYSPHERE);
                commandBuffer.drawIndexed(skysphereMesh.getIndexCount(), 1, 0, 0, 0);
            }

            commandBuffer.setPipeline(cubePipeline);
            commandBuffer.setShadingRate(NriShadingRate.Rate1x1, NriShadingRateCombiner.Keep, attachmentCombiner);
            commandBuffer.setDescriptorSet(0, set);
            this.setMesh(commandBuffer, sceneMesh);
            for (let j = 0; j < 3; j++) {
                this.setPush(commandBuffer, MESH_OFFSETS[j * 3], MESH_OFFSETS[j * 3 + 1], MESH_OFFSETS[j * 3 + 2], OBJECT_CUBE);
                commandBuffer.drawIndexed(sceneMesh.getIndexCount(), 1, 0, 0, 0);
            }
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The targets at the swap chain's size: the depth buffer and the shading rate attachment (a
        // texel per tile, its rings made for its size), and their views; false on failure.
        createSizeTargets(device: NriDevice): boolean {
            const depthTexture = device.createDepthTexture(this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            const rateWidth = Math.ceil(this.width / this.tileSize);
            const rateHeight = Math.ceil(this.height / this.tileSize);
            const pattern = this.shadingRatePattern(rateWidth, rateHeight);
            const shadingRateTexture = device.createShadingRateTexture(this.queue, rateWidth, rateHeight, Ref(pattern[0]), rateWidth, 0);
            this.shadingRateTexture = shadingRateTexture;
            if (!depthTexture || !shadingRateTexture) {
                return false;
            }
            this.depthAttachment = depthTexture.createDepthAttachmentView(NriFormat.D32_SFLOAT);
            this.shadingRateAttachment = shadingRateTexture.createShadingRateAttachmentView();
            return true;
        }

        destroySizeTargets() {
            this.destroyDescriptor(this.depthAttachment);
            this.depthAttachment = null;
            this.destroyDescriptor(this.shadingRateAttachment);
            this.shadingRateAttachment = null;
            this.destroyTexture(this.depthTexture);
            this.depthTexture = null;
            this.destroyTexture(this.shadingRateTexture);
            this.shadingRateTexture = null;
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain, the depth buffer and the shading rate attachment made again at its size, once the
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
            this.destroySizeTargets();
            this.swapChain.recreate();
            this.sizeToSwapChain();
            this.createSizeTargets(device);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.handleMouse();
            const depthAttachment = this.depthAttachment;
            const shadingRateAttachment = this.shadingRateAttachment;
            if (!depthAttachment || !shadingRateAttachment) {
                return;
            }

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: the scene with the shading rate attachment (color cleared to transparent
                // black, depth to 0), then the overlay over it.
                commandBuffer.begin();
                if (this.imgui) {
                    this.sample.copyImguiData(commandBuffer);
                }
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                commandBuffer.beginRenderingWithShadingRate(this.swapChain.colorAttachment(index), null, depthAttachment,
                    shadingRateAttachment);
                commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
                commandBuffer.clearDepth(0.0);
                this.recordDraw(commandBuffer, queuedFrame, queuedFrameIndex * UBO_STRIDE);
                commandBuffer.endRendering();
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
                this.destroyDescriptor(this.skysphereTextureView);
                this.destroyDescriptor(this.sceneTextureView);
                this.destroyDescriptor(this.sampler);
                this.destroySizeTargets();
                this.destroyTexture(this.skysphereTexture);
                this.destroyTexture(this.sceneTexture);
                this.destroyMesh(this.skysphereMesh);
                this.destroyMesh(this.sceneMesh);
                const constantBuffer = this.constantBuffer;
                if (constantBuffer) {
                    constantBuffer.destroy();
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    readbackBuffer.destroy();
                }
                this.destroyPipeline(this.skyspherePipeline);
                this.destroyPipeline(this.cubePipeline);
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
        const shadingRate = new FragmentShadingRate(sample);
        // -color: the shading rates shown; -noattachment: the full rate everywhere; -nosky: without
        // the sky sphere; -noUI: no overlay.
        sample.addExampleOption("-color");
        sample.addExampleOption("-noattachment");
        sample.addExampleOption("-nosky");
        sample.addExampleOption("-noUI");
        sample.useImgui();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-color") {
                shadingRate.colorShadingRate = true;
            } else if (arg == "-noattachment") {
                shadingRate.enableAttachmentShadingRate = false;
            } else if (arg == "-nosky") {
                shadingRate.displaySkySphere = false;
            } else if (arg == "-noUI") {
                shadingRate.noUI = true;
            }
        }
        return shadingRate.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return FragmentShadingRateNri.main(argc, argv);
}

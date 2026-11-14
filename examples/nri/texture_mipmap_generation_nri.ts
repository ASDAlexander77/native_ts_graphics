/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { identity, multiply, rotate, radians, perspective } from "../../core/matrix";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriGltfMesh, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace TextureMipmapGenerationNri {
    // texture_mipmap_generation, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework
    // instead of Donut and NVRHI: the same shaders (texture_mipmap_generation.hlsl's), model (read as
    // Donut's loadGltfMesh reads it) and texture, through the NRI calls core/nri/nri_interop.d.ts
    // binds, with NRIFramework's ImGui for the sample's overlay. This example creates everything it
    // runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Texture MipMap Generation";

    // The sample's model and texture (Vulkan-Samples' assets): a tunnel, and a checkerboard whose
    // first level only is used (the KTX texture converted to DDS at build time, see
    // VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const MODEL_PATH = "media/texture_mipmap_generation/tunnel_cylinder.gltf";
    const TEXTURE_PATH = "media/texture_mipmap_generation/checkerboard_rgba.dds";

    // NriDevice.loadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;
    const TEXCOORD_OFFSET = 24;

    // The sample's UBO: float4x4 projection, modelview; float lodBias; int samplerIndex; padded; a
    // queued frame's each in a constant buffer view of UBO_VIEW_SIZE bytes (D3D12's 256 multiple).
    const UBO_PROJECTION = 0;
    const UBO_MODELVIEW = 16;
    const UBO_LOD_BIAS = 32;
    const UBO_SAMPLER_INDEX = 33;
    const UBO_FLOATS = 36;
    const UBO_VIEW_SIZE = 256;

    // The sample's first person camera at (0, 0, -12.5) (as the view's translation), a 60 degree
    // vertical field of view, depth from 0.1 to 1024.
    const CAMERA_TRANSLATION = [0.0, 0.0, -12.5];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 0.1;
    const Z_FAR = 1024.0;

    // The sample's samplers, as its UI names them.
    const SAMPLER_NAMES = "No mip maps|Mip maps (bilinear)|Mip maps (anisotropic)";
    const SAMPLER_COUNT = 3;

    // The framework's default clear color.
    const CLEAR_COLOR = 0.002;

    // GLFW's key codes of the camera's keys: W, S, A, D.
    const CAMERA_KEYS = [87, 83, 65, 68];

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // A frame in flight's own data: its descriptor set (its copy of the UBO, the texture,
    // the samplers).
    class QueuedFrame {
        constructor(public descriptorSet: NriDescriptorSet | null, public uboView: NriDescriptor | null) {
        }
    }

    // The pixels of the frame (0xAABBGGRR) in a rectangle whose channels are all in [low, high].
    function countInRange(pixels: int[], width: int, low: int, high: int, x: int, y: int, w: int, h: int) {
        let count = 0;
        for (let j = y; j < y + h; j++) {
            for (let i = x; i < x + w; i++) {
                const p = pixels[j * width + i];
                const r = p & 0xFF;
                const g = (p >> 8) & 0xFF;
                const b = (p >> 16) & 0xFF;
                if (r >= low && r <= high && g >= low && g <= high && b >= low && b <= high) {
                    count++;
                }
            }
        }
        return count;
    }

    // count of total as a percentage in [min, max]: "" if it is, else why not.
    function share(count: int, total: int, min: number, max: number, what: string) {
        const percent = 100.0 * count / total;
        console.log(`${what}: ${percent}% (${count} of ${total} pixels)`);
        if (percent < min || percent > max) {
            return `${what}: ${percent}% of the pixels, not ${min}% to ${max}%`;
        }
        return "";
    }

    // -test: checks the last frame, read back, as the Donut example does: the checkered tunnel,
    // about 45% white; in the distance, around the middle, the generated mip levels blur the checks
    // to mid gray (about a fifth of a 300x200 rectangle there; without mipmaps it's black and white).
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const white = share(countInRange(pixels, width, 221, 255, 0, 0, width, height), width * height, 38.0, 52.0, "White");
        if (white != "") {
            return white;
        }
        return share(countInRange(pixels, width, 60, 200, width / 2 - 150, height / 2 - 100, 300, 200), 300 * 200, 12.0, 40.0,
            "Mid gray in the distance");
    }

    // The sample's camera (the framework's vkb::Camera, first person type), with ApiVulkanSample's
    // controls: the left mouse button turns it, the right one zooms, the middle one pans; W, A, S, D
    // move it. (The Donut example's SampleCamera, its keys and buttons given as held or not.)
    class SampleCamera {
        rotation: number[] = [0.0, 0.0, 0.0];
        position: number[] = [CAMERA_TRANSLATION[0], CAMERA_TRANSLATION[1], CAMERA_TRANSLATION[2]];
        private mouseX: number = 0.0;
        private mouseY: number = 0.0;
        // Left, right, middle held.
        buttons: boolean[] = [false, false, false];
        // W, S, A, D held.
        keys: boolean[] = [false, false, false, false];

        // vkb::Camera::update_view_matrix: rotations around x, y, z, then translate(position).
        view() {
            let r = identity();
            r = rotate(r, radians(this.rotation[0]), 1.0, 0.0, 0.0);
            r = rotate(r, radians(this.rotation[1]), 0.0, 1.0, 0.0);
            r = rotate(r, radians(this.rotation[2]), 0.0, 0.0, 1.0);
            let t = identity();
            t[12] = this.position[0];
            t[13] = this.position[1];
            t[14] = this.position[2];
            return multiply(r, t);
        }

        // vkb::Camera::update: first person movement, 1 unit per second.
        update(deltaTime: number) {
            const rx = radians(this.rotation[0]);
            const ry = radians(this.rotation[1]);
            const front = [-Math.cos(rx) * Math.sin(ry), Math.sin(rx), Math.cos(rx) * Math.cos(ry)];
            const length = Math.sqrt(front[0] * front[0] + front[1] * front[1] + front[2] * front[2]);
            for (let i = 0; i < 3; i++) {
                front[i] /= length;
            }
            // normalize(cross(front, (0, 1, 0))).
            const right = [-front[2], 0.0, front[0]];
            const rightLength = Math.sqrt(right[0] * right[0] + right[2] * right[2]);
            for (let i = 0; i < 3; i++) {
                right[i] /= rightLength;
            }
            for (let i = 0; i < 3; i++) {
                if (this.keys[0]) {
                    this.position[i] += front[i] * deltaTime;
                }
                if (this.keys[1]) {
                    this.position[i] -= front[i] * deltaTime;
                }
                if (this.keys[2]) {
                    this.position[i] -= right[i] * deltaTime;
                }
                if (this.keys[3]) {
                    this.position[i] += right[i] * deltaTime;
                }
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
    }

    // Port of Vulkan-Samples' texture_mipmap_generation (as examples/texture_mipmap_generation.ts
    // ports it) to NRI: a texture's first level loaded, its whole mip chain generated on the GPU (each
    // level drawn from the one above, filtered linearly, with the Donut example's downsample
    // shaders), and a tunnel textured with it through three samplers: without mip maps (levels of
    // detail clamped to 0), with mip maps, and with mip maps and anisotropic filtering; a level of
    // detail bias from the UI.
    class TextureMipmapGeneration {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private depthTexture: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
        private layout: NriPipelineLayout | null = null;
        private pipeline: NriPipeline | null = null;
        private mesh: NriGltfMesh | null = null;
        private texture: NriTexture | null = null;
        private textureView: NriDescriptor | null = null;
        private samplers: NriDescriptor[] = [];
        private uniformBuffer: NriBuffer | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views' (the swap chain's).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private swapChainViewFormat: NriFormat = NriFormat.Unknown;

        // The mip chain's generation: its layout, pipeline, sampler, and per level below the first
        // its color attachment view, the level above's view and the set reading it (index level - 1);
        // done with the first frame.
        private downsampleLayout: NriPipelineLayout | null = null;
        private downsamplePipeline: NriPipeline | null = null;
        private linearClamp: NriDescriptor | null = null;
        private levelAttachments: NriDescriptor[] = [];
        private levelViews: NriDescriptor[] = [];
        private levelSets: NriDescriptorSet[] = [];
        private mipsGenerated: boolean = false;

        // The sample's settings (-rotate, -lodbias <x>, -sampler <0..2>), from its UI; -noUI: none.
        rotateScene: boolean = false;
        lodBias: number = 0.0;
        samplerIndex: int = 2;
        noUI: boolean = false;
        private mipLevels: int = 1;
        private timer: number = 0.0;
        private imgui: boolean = false;

        private camera: SampleCamera = new SampleCamera();

        // Upload buffer.
        private ubo: f32[] = [];

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

            // Swap chain: rendered through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.swapChainViewFormat;

            // The depth buffer: D32, cleared to 1.
            if (!this.createDepth(device)) {
                return 0;
            }

            // The model, and the texture: its first level in sRGB (as the sample takes KTX 1 files)
            // with the whole chain below it, generated with the first frame.
            this.mesh = device.loadGltfMesh(this.queue, MODEL_PATH);
            const texture = device.loadDdsTextureWithMipChain(this.queue, TEXTURE_PATH, 1);
            this.texture = texture;
            if (!this.mesh || !texture) {
                console.log("Cannot load the model and texture: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            this.mipLevels = texture.getMipNum();
            const textureView = texture.createView(NriFormat.RGBA8_SRGB);
            this.textureView = textureView;

            // The sample's samplers: linear, repeating; without mip maps (levels of detail up to 0),
            // with mip maps (up to the mip level count), and with anisotropic filtering too, at the
            // device's most. The generation's: linear, clamped, level 0 of the view it reads.
            const maxLod = this.mipLevels;
            const noMipMaps = device.createSamplerWithLodRange(NriFilter.Linear, NriFilter.Linear, NriAddressMode.Repeat, 1, 0.0, 0.0);
            const mipMaps = device.createSamplerWithLodRange(NriFilter.Linear, NriFilter.Linear, NriAddressMode.Repeat, 1, 0.0, maxLod);
            const anisotropic = device.createSamplerWithLodRange(NriFilter.Linear, NriFilter.Linear, NriAddressMode.Repeat,
                device.getMaxSamplerAnisotropy(), 0.0, maxLod);
            const linearClamp = device.createSamplerWithLodRange(NriFilter.Linear, NriFilter.Linear, NriAddressMode.ClampToEdge, 1, 0.0, 0.0);
            this.linearClamp = linearClamp;
            if (!noMipMaps || !mipMaps || !anisotropic || !linearClamp) {
                console.log("Cannot create the samplers");
                return 0;
            }
            this.samplers.push(noMipMaps);
            this.samplers.push(mipMaps);
            this.samplers.push(anisotropic);

            // The layouts: the tunnel's UBO (b0, both shaders'), texture (t0) and samplers (s0 to
            // s2); the generation's level above (t0) and sampler (s0).
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, SAMPLER_COUNT, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            const layout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
            this.layout = layout;
            const downsampleLayoutDesc = NriPipelineLayoutDesc.create();
            downsampleLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            downsampleLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            const downsampleLayout = device.createPipelineLayoutFromDesc(downsampleLayoutDesc);
            downsampleLayoutDesc.destroy();
            this.downsampleLayout = downsampleLayout;
            if (!layout || !downsampleLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The pipelines: the Donut example's shaders, as compiled for it.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/texture_mipmap_generation/${folder}/texture_mipmap_generation`;
            this.pipeline = this.createPipeline(device, layout, shaders);
            this.downsamplePipeline = this.createDownsamplePipeline(device, downsampleLayout, shaders);
            if (!this.pipeline || !this.downsamplePipeline) {
                console.log("Cannot load the texture mipmap generation shaders");
                return 0;
            }

            // A queued frame's UBO each, in its own descriptor set with the texture and samplers; a
            // set per generated level.
            const levelSetNum = this.mipLevels - 1;
            const uniformBuffer = device.createHostBuffer(queuedFrameNum * UBO_VIEW_SIZE, NriBufferUsage.ConstantBuffer);
            this.uniformBuffer = uniformBuffer;
            const descriptorPool = device.createDescriptorPool(queuedFrameNum + levelSetNum, SAMPLER_COUNT * queuedFrameNum + levelSetNum,
                queuedFrameNum, queuedFrameNum + levelSetNum, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!uniformBuffer || !descriptorPool) {
                console.log("Cannot create the descriptors");
                return 0;
            }
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const descriptorSet = descriptorPool.allocateDescriptorSet(layout, 0, 0);
                const uboView = uniformBuffer.createConstantView(i * UBO_VIEW_SIZE, UBO_VIEW_SIZE);
                this.queuedFrames.push(new QueuedFrame(descriptorSet, uboView));
                if (!descriptorSet || !uboView) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                descriptorSet.updateDescriptor(0, 0, uboView);
                descriptorSet.updateDescriptor(1, 0, textureView);
                for (let s = 0; s < SAMPLER_COUNT; s++) {
                    descriptorSet.updateDescriptor(2, s, this.samplers[s]);
                }
            }
            for (let level = 1; level < this.mipLevels; level++) {
                const levelSet = descriptorPool.allocateDescriptorSet(downsampleLayout, 0, 0);
                if (!levelSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                const levelView = texture.createMipView(NriFormat.RGBA8_SRGB, level - 1);
                this.levelAttachments.push(texture.createColorAttachmentMipView(NriFormat.RGBA8_SRGB, level));
                this.levelViews.push(levelView);
                this.levelSets.push(levelSet);
                levelSet.updateDescriptor(0, 0, levelView);
                levelSet.updateDescriptor(1, 0, linearClamp);
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

        // The sample's pipeline: position and texture coordinates of the glTF loader's vertices,
        // depth tested (less or equal) and written, no culling.
        createPipeline(device: NriDevice, layout: NriPipelineLayout, shaders: string) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_main_vs.bin`, "main_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_main_ps.bin`, "main_ps") != 0;
            }
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            desc.addVertexAttribute("TEXCOORD", NriFormat.RG32_SFLOAT, TEXCOORD_OFFSET);
            desc.setCullMode(NriCullMode.None);
            desc.setFrontCounterClockwise(1);
            desc.setColor(this.viewFormat, NriColorWrite.RGBA);
            desc.setDepth(NriFormat.D32_SFLOAT, NriCompareOp.LessEqual, 1, 0);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        // The generation's pipeline: a triangle over the level drawn into (sRGB: averaged in linear
        // space), no depth, no culling.
        createDownsamplePipeline(device: NriDevice, layout: NriPipelineLayout, shaders: string) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_downsample_vs.bin`, "downsample_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_downsample_ps.bin`, "downsample_ps") != 0;
            }
            desc.setCullMode(NriCullMode.None);
            desc.setColor(NriFormat.RGBA8_SRGB, NriColorWrite.RGBA);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        // Waits for the frame that last used this frame's command allocator (and its UBO).
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The camera's input (ApiVulkanSample's), the mouse unless the overlay has it; then the
        // sample's update over the frame's time (Donut's test mode: 1/60 s, as a float): the camera's
        // movement, the scene's rotation.
        animate() {
            const overlay = this.imgui && NriImgui.wantsMouse() != 0;
            for (let button = 0; button < 3; button++) {
                const pressed = this.sample.isButtonPressed(button) != 0;
                if (!pressed || !overlay) {
                    this.camera.buttons[button] = pressed;
                }
            }
            if (!overlay) {
                this.camera.mouseMove(this.sample.getMouseX(), this.sample.getMouseY());
            }
            for (let k = 0; k < CAMERA_KEYS.length; k++) {
                this.camera.keys[k] = this.sample.isKeyPressed(CAMERA_KEYS[k]) != 0;
            }
            const elapsedSeconds = this.test ? Math.fround(1.0 / 60.0) : this.sample.getFrameTime();
            this.camera.update(elapsedSeconds);
            if (this.rotateScene) {
                this.timer += elapsedSeconds * 0.005;
                if (this.timer > 1.0) {
                    this.timer -= 1.0;
                }
            }
        }

        // The sample's overlay.
        buildUI() {
            this.sample.imguiNewFrame();
            NriImgui.setNextWindowPos(10.0, 10.0);
            NriImgui.begin("Options", 1);
            if (NriImgui.collapsingHeader("Settings", 1) != 0) {
                this.rotateScene = NriImgui.checkbox("Rotate", this.rotateScene ? 1 : 0) != 0;
                this.lodBias = NriImgui.sliderFloat("LOD bias", this.lodBias, 0.0, this.mipLevels);
                this.samplerIndex = NriImgui.combo("Sampler type", this.samplerIndex, SAMPLER_NAMES);
            }
            NriImgui.end();
            this.sample.imguiRender();
        }

        // The sample's update_uniform_buffers: its projection (clip y negated, as the Donut example
        // gives it), the view turned by 90 degrees (and the timer) around z and scaled by 0.5; the
        // level of detail bias and the sampler; into this frame's UBO.
        writeUbo(queuedFrameIndex: int) {
            const uniformBuffer = this.uniformBuffer;
            if (!uniformBuffer) {
                return;
            }
            const projection = perspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR);
            let model = rotate(this.camera.view(), radians(90.0 + this.timer * 360.0), 0.0, 0.0, 1.0);
            for (let i = 0; i < 12; i++) {
                model[i] *= 0.5;
            }
            const u = this.ubo;
            for (let i = 0; i < 16; i++) {
                u[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                u[UBO_MODELVIEW + i] = model[i];
            }
            u[UBO_LOD_BIAS] = this.lodBias;
            Nri.storeInt32(Ref(u[UBO_SAMPLER_INDEX]), this.samplerIndex);
            uniformBuffer.write(queuedFrameIndex * UBO_VIEW_SIZE, Ref(u[0]), UBO_FLOATS * 4);
        }

        // The sample's load_texture_generate_mipmaps' blits: each level drawn from the one above, in
        // order (outside rendering).
        recordMipGeneration(commandBuffer: NriCommandBuffer) {
            const texture = this.texture;
            const downsampleLayout = this.downsampleLayout;
            const downsamplePipeline = this.downsamplePipeline;
            const descriptorPool = this.descriptorPool;
            if (!texture || !downsampleLayout || !downsamplePipeline || !descriptorPool) {
                return;
            }
            const width = texture.getWidth();
            const height = texture.getHeight();
            commandBuffer.setDescriptorPool(descriptorPool);
            for (let level = 1; level < this.mipLevels; level++) {
                commandBuffer.textureMipBarrier(texture, level, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
                commandBuffer.beginRendering(this.levelAttachments[level - 1]);
                // The level's size: the texture's halved `level` times (at least 1).
                const levelWidth = Math.max(1, width >> level);
                const levelHeight = Math.max(1, height >> level);
                commandBuffer.setViewport(0.0, 0.0, levelWidth, levelHeight);
                commandBuffer.setScissor(0, 0, levelWidth, levelHeight);
                commandBuffer.setPipelineLayout(downsampleLayout);
                commandBuffer.setPipeline(downsamplePipeline);
                commandBuffer.setDescriptorSet(0, this.levelSets[level - 1]);
                commandBuffer.draw(3, 1, 0, 0);
                commandBuffer.endRendering();
                commandBuffer.textureMipBarrier(texture, level, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
            }
            this.mipsGenerated = true;
        }

        // The tunnel (between NriCommandBuffer.beginRenderingWithDepth and NriCommandBuffer.endRendering).
        recordDraw(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const layout = this.layout;
            const pipeline = this.pipeline;
            const descriptorPool = this.descriptorPool;
            const descriptorSet = queuedFrame.descriptorSet;
            const mesh = this.mesh;
            if (!layout || !pipeline || !descriptorPool || !descriptorSet || !mesh) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(layout);
            commandBuffer.setDescriptorSet(0, descriptorSet);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setIndexBuffer(mesh.getIndexBuffer(), 0, NriIndexType.UInt32);
            commandBuffer.setVertexBuffer(0, mesh.getVertexBuffer(), 0, VERTEX_SIZE);
            commandBuffer.drawIndexed(mesh.getIndexCount(), 1, 0, 0, 0);
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The depth buffer at the swap chain's size.
        createDepth(device: NriDevice): boolean {
            const depthTexture = device.createDepthTexture(this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
                console.log("Cannot create the depth buffer");
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

        // The window was resized (NriSample.useResizableWindow): the swap chain and the depth buffer made
        // again at its size, once the GPU is done with the old ones.
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
            if (this.imgui) {
                this.buildUI();
            }
            this.animate();
            this.writeUbo(queuedFrameIndex);

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: the mip chain (once); the framework's clear color, depth cleared to 1, the
                // tunnel; then the overlay over it.
                commandBuffer.begin();
                if (this.imgui) {
                    this.sample.copyImguiData(commandBuffer);
                }
                if (!this.mipsGenerated) {
                    this.recordMipGeneration(commandBuffer);
                }
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    commandBuffer.beginRenderingWithDepth(this.swapChain.colorAttachment(index), depthAttachment);
                    commandBuffer.clearColor(CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
                    commandBuffer.clearDepth(1.0);
                    this.recordDraw(commandBuffer, queuedFrame);
                    commandBuffer.endRendering();
                }
                // (A pass of its own: the UI's pipeline has no depth attachment.)
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
                    this.destroyDescriptor(queuedFrame.uboView);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                for (const view of this.levelAttachments) {
                    view.destroy();
                }
                for (const view of this.levelViews) {
                    view.destroy();
                }
                for (const sampler of this.samplers) {
                    sampler.destroy();
                }
                this.destroyDescriptor(this.linearClamp);
                this.destroyDescriptor(this.textureView);
                this.destroyDescriptor(this.depthAttachment);
                this.destroyTexture(this.texture);
                this.destroyTexture(this.depthTexture);
                const mesh = this.mesh;
                if (mesh) {
                    mesh.destroy();
                }
                this.destroyBuffer(this.uniformBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.pipeline);
                this.destroyPipeline(this.downsamplePipeline);
                const layout = this.layout;
                if (layout) {
                    layout.destroy();
                }
                const downsampleLayout = this.downsampleLayout;
                if (downsampleLayout) {
                    downsampleLayout.destroy();
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
        const mipmapGeneration = new TextureMipmapGeneration(sample);
        // -sampler <0..2>, -lodbias <x>, -rotate: the settings' initial values; -noUI: no overlay.
        sample.addExampleOptionWithValues("-sampler", 1);
        sample.addExampleOptionWithValues("-lodbias", 1);
        sample.addExampleOption("-rotate");
        sample.addExampleOption("-noUI");
        sample.useImgui();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-sampler" && i + 1 < argc) {
                i++;
                mipmapGeneration.samplerIndex = Math.min(2, Math.max(0, parseInt(Nri.getArg(argc, argv, i))));
            } else if (arg == "-lodbias" && i + 1 < argc) {
                i++;
                mipmapGeneration.lodBias = parseFloat(Nri.getArg(argc, argv, i));
            } else if (arg == "-rotate") {
                mipmapGeneration.rotateScene = true;
            } else if (arg == "-noUI") {
                mipmapGeneration.noUI = true;
            }
        }
        return mipmapGeneration.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return TextureMipmapGenerationNri.main(argc, argv);
}

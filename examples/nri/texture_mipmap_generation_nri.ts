/// <reference path="../../core/nri/nri_interop.d.ts" />
import { identity, multiply, rotate, radians, perspective } from "../../core/matrix";

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

    // Nri_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
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

    // What a frame in flight records into, and its descriptor set (its copy of the UBO, the texture,
    // the samplers).
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public descriptorSet: NriDescriptorSetHandle | null, public uboView: NriDescriptorHandle | null) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
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
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private depthTexture: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private layout: NriPipelineLayoutHandle | null = null;
        private pipeline: NriPipelineHandle | null = null;
        private mesh: NriGltfMeshHandle | null = null;
        private texture: NriTextureHandle | null = null;
        private textureView: NriDescriptorHandle | null = null;
        private samplers: NriDescriptorHandle[] = [];
        private uniformBuffer: NriBufferHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private width: int = 0;
        private height: int = 0;

        // The mip chain's generation: its layout, pipeline, sampler, and per level below the first
        // its color attachment view, the level above's view and the set reading it (index level - 1);
        // done with the first frame.
        private downsampleLayout: NriPipelineLayoutHandle | null = null;
        private downsamplePipeline: NriPipelineHandle | null = null;
        private linearClamp: NriDescriptorHandle | null = null;
        private levelAttachments: NriDescriptorHandle[] = [];
        private levelViews: NriDescriptorHandle[] = [];
        private levelSets: NriDescriptorSetHandle[] = [];
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

            // The depth buffer: D32, cleared to 1.
            const depthTexture = Nri_CreateDepthTexture(device, this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
                console.log("Cannot create the depth buffer");
                return 0;
            }
            this.depthAttachment = Nri_CreateDepthAttachmentView(depthTexture, NriFormat.D32_SFLOAT);

            // The model, and the texture: its first level in sRGB (as the sample takes KTX 1 files)
            // with the whole chain below it, generated with the first frame.
            this.mesh = Nri_LoadGltfMesh(device, this.queue, MODEL_PATH);
            const texture = Nri_LoadDdsTextureWithMipChain(device, this.queue, TEXTURE_PATH, 1);
            this.texture = texture;
            if (!this.mesh || !texture) {
                console.log("Cannot load the model and texture: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            this.mipLevels = Nri_GetTextureMipNum(texture);
            const textureView = Nri_CreateTextureView(texture, NriFormat.RGBA8_SRGB);
            this.textureView = textureView;

            // The sample's samplers: linear, repeating; without mip maps (levels of detail up to 0),
            // with mip maps (up to the mip level count), and with anisotropic filtering too, at the
            // device's most. The generation's: linear, clamped, level 0 of the view it reads.
            const maxLod = this.mipLevels;
            const noMipMaps = Nri_CreateSamplerWithLodRange(device, NriFilter.Linear, NriFilter.Linear, NriAddressMode.Repeat, 1, 0.0, 0.0);
            const mipMaps = Nri_CreateSamplerWithLodRange(device, NriFilter.Linear, NriFilter.Linear, NriAddressMode.Repeat, 1, 0.0, maxLod);
            const anisotropic = Nri_CreateSamplerWithLodRange(device, NriFilter.Linear, NriFilter.Linear, NriAddressMode.Repeat,
                Nri_GetMaxSamplerAnisotropy(device), 0.0, maxLod);
            const linearClamp = Nri_CreateSamplerWithLodRange(device, NriFilter.Linear, NriFilter.Linear, NriAddressMode.ClampToEdge, 1, 0.0, 0.0);
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
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, SAMPLER_COUNT, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            const layout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            this.layout = layout;
            const downsampleLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(downsampleLayoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(downsampleLayoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            const downsampleLayout = Nri_CreatePipelineLayoutFromDesc(device, downsampleLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(downsampleLayoutDesc);
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
            const uniformBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * UBO_VIEW_SIZE, NriBufferUsage.ConstantBuffer);
            this.uniformBuffer = uniformBuffer;
            const descriptorPool = Nri_CreateDescriptorPool(device, queuedFrameNum + levelSetNum, SAMPLER_COUNT * queuedFrameNum + levelSetNum,
                queuedFrameNum, queuedFrameNum + levelSetNum, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!uniformBuffer || !descriptorPool) {
                console.log("Cannot create the descriptors");
                return 0;
            }
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const descriptorSet = Nri_AllocateDescriptorSet(descriptorPool, layout, 0, 0);
                const uboView = Nri_CreateConstantBufferView(uniformBuffer, i * UBO_VIEW_SIZE, UBO_VIEW_SIZE);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), descriptorSet, uboView));
                if (!descriptorSet || !uboView) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(descriptorSet, 0, 0, uboView);
                Nri_UpdateDescriptor(descriptorSet, 1, 0, textureView);
                for (let s = 0; s < SAMPLER_COUNT; s++) {
                    Nri_UpdateDescriptor(descriptorSet, 2, s, this.samplers[s]);
                }
            }
            for (let level = 1; level < this.mipLevels; level++) {
                const levelSet = Nri_AllocateDescriptorSet(descriptorPool, downsampleLayout, 0, 0);
                if (!levelSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                const levelView = Nri_CreateTextureMipView(texture, NriFormat.RGBA8_SRGB, level - 1);
                this.levelAttachments.push(Nri_CreateColorAttachmentMipView(texture, NriFormat.RGBA8_SRGB, level));
                this.levelViews.push(levelView);
                this.levelSets.push(levelSet);
                Nri_UpdateDescriptor(levelSet, 0, 0, levelView);
                Nri_UpdateDescriptor(levelSet, 1, 0, linearClamp);
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

        // The sample's pipeline: position and texture coordinates of the glTF loader's vertices,
        // depth tested (less or equal) and written, no culling.
        createPipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, shaders: string) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_main_vs.bin`, "main_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_main_ps.bin`, "main_ps") != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescAddVertexAttribute(desc, "TEXCOORD", NriFormat.RG32_SFLOAT, TEXCOORD_OFFSET);
            Nri_PipelineDescSetCullMode(desc, NriCullMode.None);
            Nri_PipelineDescSetFrontCounterClockwise(desc, 1);
            Nri_PipelineDescSetColor(desc, this.viewFormat, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.LessEqual, 1, 0);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // The generation's pipeline: a triangle over the level drawn into (sRGB: averaged in linear
        // space), no depth, no culling.
        createDownsamplePipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, shaders: string) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_downsample_vs.bin`, "downsample_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_downsample_ps.bin`, "downsample_ps") != 0;
            }
            Nri_PipelineDescSetCullMode(desc, NriCullMode.None);
            Nri_PipelineDescSetColor(desc, NriFormat.RGBA8_SRGB, NriColorWrite.RGBA);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
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

        // The camera's input (ApiVulkanSample's), the mouse unless the overlay has it; then the
        // sample's update over the frame's time (Donut's test mode: 1/60 s, as a float): the camera's
        // movement, the scene's rotation.
        animate() {
            const overlay = this.imgui && Nri_ImguiWantsMouse() != 0;
            for (let button = 0; button < 3; button++) {
                const pressed = Nri_IsButtonPressed(this.sample, button) != 0;
                if (!pressed || !overlay) {
                    this.camera.buttons[button] = pressed;
                }
            }
            if (!overlay) {
                this.camera.mouseMove(Nri_GetMouseX(this.sample), Nri_GetMouseY(this.sample));
            }
            for (let k = 0; k < CAMERA_KEYS.length; k++) {
                this.camera.keys[k] = Nri_IsKeyPressed(this.sample, CAMERA_KEYS[k]) != 0;
            }
            const elapsedSeconds = this.test ? Math.fround(1.0 / 60.0) : Nri_GetFrameTime(this.sample);
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
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPos(10.0, 10.0);
            Nri_ImguiBegin("Options", 1);
            if (Nri_ImguiCollapsingHeader("Settings", 1) != 0) {
                this.rotateScene = Nri_ImguiCheckbox("Rotate", this.rotateScene ? 1 : 0) != 0;
                this.lodBias = Nri_ImguiSliderFloat("LOD bias", this.lodBias, 0.0, this.mipLevels);
                this.samplerIndex = Nri_ImguiCombo("Sampler type", this.samplerIndex, SAMPLER_NAMES);
            }
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
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
            Nri_StoreInt32(Ref(u[UBO_SAMPLER_INDEX]), this.samplerIndex);
            Nri_WriteBuffer(uniformBuffer, queuedFrameIndex * UBO_VIEW_SIZE, Ref(u[0]), UBO_FLOATS * 4);
        }

        // The sample's load_texture_generate_mipmaps' blits: each level drawn from the one above, in
        // order (outside rendering).
        recordMipGeneration(commandBuffer: NriCommandBufferHandle) {
            const texture = this.texture;
            const downsampleLayout = this.downsampleLayout;
            const downsamplePipeline = this.downsamplePipeline;
            const descriptorPool = this.descriptorPool;
            if (!texture || !downsampleLayout || !downsamplePipeline || !descriptorPool) {
                return;
            }
            const width = Nri_GetTextureWidth(texture);
            const height = Nri_GetTextureHeight(texture);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            for (let level = 1; level < this.mipLevels; level++) {
                Nri_CmdTextureMipBarrier(commandBuffer, texture, level, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
                Nri_CmdBeginRendering(commandBuffer, this.levelAttachments[level - 1]);
                // The level's size: the texture's halved `level` times (at least 1).
                const levelWidth = Math.max(1, width >> level);
                const levelHeight = Math.max(1, height >> level);
                Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, levelWidth, levelHeight);
                Nri_CmdSetScissor(commandBuffer, 0, 0, levelWidth, levelHeight);
                Nri_CmdSetPipelineLayout(commandBuffer, downsampleLayout);
                Nri_CmdSetPipeline(commandBuffer, downsamplePipeline);
                Nri_CmdSetDescriptorSet(commandBuffer, 0, this.levelSets[level - 1]);
                Nri_CmdDraw(commandBuffer, 3, 1, 0, 0);
                Nri_CmdEndRendering(commandBuffer);
                Nri_CmdTextureMipBarrier(commandBuffer, texture, level, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
            }
            this.mipsGenerated = true;
        }

        // The tunnel (between Nri_CmdBeginRenderingWithDepth and Nri_CmdEndRendering).
        recordDraw(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const layout = this.layout;
            const pipeline = this.pipeline;
            const descriptorPool = this.descriptorPool;
            const descriptorSet = queuedFrame.descriptorSet;
            const mesh = this.mesh;
            if (!layout || !pipeline || !descriptorPool || !descriptorSet || !mesh) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, layout);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, descriptorSet);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetIndexBuffer(commandBuffer, Nri_GetGltfMeshIndexBuffer(mesh), 0, NriIndexType.UInt32);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, Nri_GetGltfMeshVertexBuffer(mesh), 0, VERTEX_SIZE);
            Nri_CmdDrawIndexed(commandBuffer, Nri_GetGltfMeshIndexCount(mesh), 1, 0, 0, 0);
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.animate();
            this.writeUbo(queuedFrameIndex);

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: the mip chain (once); the framework's clear color, depth cleared to 1, the
                // tunnel; then the overlay over it.
                Nri_BeginCommandBuffer(commandBuffer);
                if (this.imgui) {
                    Nri_CmdCopyImguiData(this.sample, commandBuffer);
                }
                if (!this.mipsGenerated) {
                    this.recordMipGeneration(commandBuffer);
                }
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    Nri_CmdBeginRenderingWithDepth(commandBuffer, swapChainTexture.colorAttachment, depthAttachment);
                    Nri_CmdClearColor(commandBuffer, CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
                    Nri_CmdClearDepth(commandBuffer, 1.0);
                    this.recordDraw(commandBuffer, queuedFrame);
                    Nri_CmdEndRendering(commandBuffer);
                }
                // (A pass of its own: the UI's pipeline has no depth attachment.)
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
                for (const view of this.levelAttachments) {
                    Nri_DestroyDescriptor(view);
                }
                for (const view of this.levelViews) {
                    Nri_DestroyDescriptor(view);
                }
                for (const sampler of this.samplers) {
                    Nri_DestroyDescriptor(sampler);
                }
                this.destroyDescriptor(this.linearClamp);
                this.destroyDescriptor(this.textureView);
                this.destroyDescriptor(this.depthAttachment);
                this.destroyTexture(this.texture);
                this.destroyTexture(this.depthTexture);
                const mesh = this.mesh;
                if (mesh) {
                    Nri_DestroyGltfMesh(mesh);
                }
                this.destroyBuffer(this.uniformBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.pipeline);
                this.destroyPipeline(this.downsamplePipeline);
                const layout = this.layout;
                if (layout) {
                    Nri_DestroyPipelineLayout(layout);
                }
                const downsampleLayout = this.downsampleLayout;
                if (downsampleLayout) {
                    Nri_DestroyPipelineLayout(downsampleLayout);
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
        const mipmapGeneration = new TextureMipmapGeneration(sample);
        // -sampler <0..2>, -lodbias <x>, -rotate: the settings' initial values; -noUI: no overlay.
        Nri_AddExampleOptionWithValues(sample, "-sampler", 1);
        Nri_AddExampleOptionWithValues(sample, "-lodbias", 1);
        Nri_AddExampleOption(sample, "-rotate");
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-sampler" && i + 1 < argc) {
                i++;
                mipmapGeneration.samplerIndex = Math.min(2, Math.max(0, parseInt(Nri_GetArg(argc, argv, i))));
            } else if (arg == "-lodbias" && i + 1 < argc) {
                i++;
                mipmapGeneration.lodBias = parseFloat(Nri_GetArg(argc, argv, i));
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

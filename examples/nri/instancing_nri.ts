/// <reference path="../../core/nri/nri_interop.d.ts" />
import { perspProjReverse, radiansF32 } from "../../core/matrix";
import { randomFloat } from "../../core/random";

namespace InstancingNri {
    // instancing, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut
    // and NVRHI: the same shaders (instancing.hlsl's, and Donut's blit shaders), models (read as
    // Donut's loadGltfMesh reads them) and textures, through the NRI calls core/nri/nri_interop.d.ts
    // binds, with NRIFramework's ImGui for the sample's overlay. This example creates everything it
    // runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Instanced Mesh Rendering";

    // The sample's models and textures (Vulkan-Samples' assets), the KTX textures converted to DDS at
    // build time (see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const ROCK_PATH = "media/instancing/rock.gltf";
    const PLANET_PATH = "media/instancing/planet.gltf";
    const ROCK_TEXTURES_PATH = "media/instancing/texturearray_rocks_color_rgba.dds";
    const PLANET_TEXTURE_PATH = "media/instancing/lavaplanet_color_rgba.dds";
    // Layers of the rocks' texture array.
    const ROCK_TEXTURE_LAYERS = 5;

    const INSTANCE_COUNT = 8192;

    // Nri_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;
    // struct InstanceData { float3 pos; float3 rot; float scale; uint texIndex; }
    const INSTANCE_FLOATS = 8;
    const INSTANCE_SIZE = INSTANCE_FLOATS * 4;

    // struct UBO, as f32 offsets (HLSL packing); a queued frame's in a 256-byte slice of the constant
    // buffer (D3D12 constant buffer views' alignment).
    const CONST_PROJECTION = 0;
    const CONST_MODELVIEW = 16;
    const CONST_LIGHT_POS = 32;
    const CONST_LOC_SPEED = 36;
    const CONST_GLOB_SPEED = 37;
    // Padded to 16 bytes.
    const CONST_FLOATS = 40;
    const CONST_STRIDE = 256;

    // Donut's blit (CommonRenderPasses::BlitTexture) of the color buffer into the swap chain
    // texture: struct BlitConstants { float2 sourceOrigin, sourceSize, targetOrigin, targetSize;
    // float sharpenFactor; }.
    const BLIT_CONSTANT_FLOATS = 9;

    // The sample's camera: reversed depth from 0.1 to 256.
    const Z_NEAR = 0.1;
    const Z_FAR = 256.0;

    // GLFW's key code of P (Donut's Key.P): pauses the animation.
    const KEY_P = 80;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into: its command buffer, and its descriptor sets (the rocks'
    // and the planet's: the UBO's slice, a texture, the sampler) with the UBO's view.
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public rocksSet: NriDescriptorSetHandle | null, public planetSet: NriDescriptorSetHandle | null,
            public uboView: NriDescriptorHandle | null) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // -test: checks the last frame, read back, as the Donut example does. The corners are black
    // space; the planet in the middle and the rock instances around it light 20% to 40% of the
    // frame.
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
        if ((pixels[(height / 2) * width + width / 2] & 0xFFFFFF) == 0) {
            return "no planet in the middle";
        }
        const total = width * height;
        let dark = 0;
        for (let i = 0; i < total; i++) {
            const p = pixels[i];
            if ((p & 0xFF) <= 20 && ((p >> 8) & 0xFF) <= 20 && ((p >> 16) & 0xFF) <= 20) {
                dark++;
            }
        }
        const percent = 100.0 * (total - dark) / total;
        console.log(`Planet and rocks: ${percent}% (${total - dark} of ${total} pixels)`);
        if (percent < 20.0 || percent > 40.0) {
            return `Planet and rocks: ${percent}% of the pixels, not 20% to 40%`;
        }
        return "";
    }

    // Quaternion product a * b, (w, x, y, z), in float32 as donut::math's.
    function quatMultiply(a: number[], b: number[]) {
        const f = Math.fround;
        return [
            f(f(f(f(a[0] * b[0]) - f(a[1] * b[1])) - f(a[2] * b[2])) - f(a[3] * b[3])),
            f(f(f(f(a[0] * b[1]) + f(a[1] * b[0])) + f(a[2] * b[3])) - f(a[3] * b[2])),
            f(f(f(f(a[0] * b[2]) + f(a[2] * b[0])) + f(a[3] * b[1])) - f(a[1] * b[3])),
            f(f(f(f(a[0] * b[3]) + f(a[3] * b[0])) + f(a[1] * b[2])) - f(a[2] * b[1])),
        ];
    }

    // Donut's ThirdPersonCamera, as the Donut example uses it: orbiting target at distance, turned
    // by yaw and pitch (the left mouse button drags them, the wheel zooms), placed by LookTo (as
    // Donut_ThirdPersonCameraLookAt does). Its world-to-view matrix in float32, as Donut computes it
    // (compute_nbody_nri's port).
    class ThirdPersonCamera {
        target: number[] = [0.0, 0.0, 0.0];
        distance: number = 0.0;
        yaw: number = 0.0;
        pitch: number = 0.0;
        // mouse sensitivity in radians/pixel
        rotateSpeed: number = 0.005;

        // Row-major, for row vectors (Donut's affineToHomogeneous(m_MatWorldToView)).
        worldToView: number[] = [];

        // ThirdPersonCamera::LookTo(position, target - position, length(target - position)): the
        // orbit's angles from dm::cartesianToSpherical of the opposite direction.
        lookAt(posX: number, posY: number, posZ: number, targetX: number, targetY: number, targetZ: number) {
            const f = Math.fround;
            const position = [f(posX), f(posY), f(posZ)];
            const direction = [f(f(targetX) - position[0]), f(f(targetY) - position[1]), f(f(targetZ) - position[2])];
            const v = [-direction[0], -direction[1], -direction[2]];
            const length = f(Math.sqrt(f(f(f(v[0] * v[0]) + f(v[1] * v[1])) + f(v[2] * v[2]))));
            let azimuth = 0.0;
            let elevation = 0.0;
            if (length != 0.0) {
                const vn = [f(v[0] / length), f(v[1] / length), f(v[2] / length)];
                elevation = f(Math.asin(vn[1]));
                if (vn[2] != 0.0 || vn[0] != 0.0) {
                    azimuth = f(Math.atan2(vn[2], vn[0]));
                }
            }
            for (let i = 0; i < 3; i++) {
                this.target[i] = f(position[i] + f(f(direction[i] / length) * length));
            }
            this.distance = length;
            this.yaw = f(-f(azimuth + f(f(Math.PI) * 0.5)));
            this.pitch = elevation;
        }

        // ThirdPersonCamera::AnimateOrbit with the mouse's motion (when orbiting) and
        // MouseScrollUpdate with the wheel's.
        orbit(deltaX: number, deltaY: number, wheel: number) {
            const f = Math.fround;
            this.yaw = f(this.yaw - f(this.rotateSpeed * f(deltaX)));
            this.pitch = f(this.pitch + f(this.rotateSpeed * f(deltaY)));
            // (Explicit: tslang's Math.max gets negative numbers wrong.)
            if (this.pitch < f(-0.5 * Math.PI)) {
                this.pitch = f(-0.5 * Math.PI);
            }
            if (this.pitch > f(0.5 * Math.PI)) {
                this.pitch = f(0.5 * Math.PI);
            }
            if (wheel != 0.0) {
                this.distance = f(wheel < 0.0 ? this.distance * f(1.15) : this.distance * f(1.0 / f(1.15)));
            }
        }

        // ThirdPersonCamera::Animate's world-to-view matrix.
        animate() {
            const f = Math.fround;
            // rotationQuat(float3(pitch, yaw, 0)).toMatrix()
            const halfX = f(0.5 * this.pitch);
            const halfY = f(0.5 * this.yaw);
            const quatX = [f(Math.cos(halfX)), f(Math.sin(halfX)), 0.0, 0.0];
            const quatY = [f(Math.cos(halfY)), 0.0, f(Math.sin(halfY)), 0.0];
            const quatZ = [1.0, 0.0, 0.0, 0.0];
            const q = quatMultiply(quatMultiply(quatZ, quatY), quatX);
            const w = q[0];
            const x = q[1];
            const y = q[2];
            const z = q[3];
            const row0 = [f(1.0 - f(2.0 * f(f(y * y) + f(z * z)))), f(2.0 * f(f(x * y) + f(z * w))), f(2.0 * f(f(x * z) - f(y * w)))];
            const row1 = [f(2.0 * f(f(x * y) - f(z * w))), f(1.0 - f(2.0 * f(f(x * x) + f(z * z)))), f(2.0 * f(f(y * z) + f(x * w)))];
            const row2 = [f(2.0 * f(f(x * z) + f(y * w))), f(2.0 * f(f(y * z) - f(x * w))), f(1.0 - f(2.0 * f(f(x * x) + f(y * y))))];

            // The camera at target - distance * forward; right = -row0, up = row1, forward = row2.
            const camPos = [0.0, 0.0, 0.0];
            const right = [0.0, 0.0, 0.0];
            for (let i = 0; i < 3; i++) {
                camPos[i] = f(this.target[i] + f(f(-this.distance) * row2[i]));
                right[i] = -row0[i];
            }

            // translation(-camPos) * affine3::from_cols(right, up, forward, 0)
            const columns = [right, row1, row2];
            const m: number[] = [];
            for (let r = 0; r < 3; r++) {
                for (let c = 0; c < 3; c++) {
                    m.push(columns[c][r]);
                }
                m.push(0.0);
            }
            for (let c = 0; c < 3; c++) {
                const column = columns[c];
                m.push(f(f(f(f(-camPos[0]) * column[0]) + f(f(-camPos[1]) * column[1])) + f(f(-camPos[2]) * column[2])));
            }
            m.push(1.0);
            this.worldToView = m;
        }
    }

    // Port of Vulkan-Samples' instancing (as examples/instancing.ts ports it) to NRI: a field of rocks
    // on two rings around a planet, drawn with one instanced draw whose second vertex buffer holds
    // each rock's position, rotation, scale and texture array layer, read once per instance; in front
    // of a procedural star field. Rendered into an RGBA8 color buffer, then blitted into the sRGB swap
    // chain texture with Donut's blit shaders, as the Donut example does.
    class Instancing {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private meshLayout: NriPipelineLayoutHandle | null = null;
        private blitLayout: NriPipelineLayoutHandle | null = null;
        private rocksPipeline: NriPipelineHandle | null = null;
        private planetPipeline: NriPipelineHandle | null = null;
        private starfieldPipeline: NriPipelineHandle | null = null;
        private blitPipeline: NriPipelineHandle | null = null;
        private rock: NriGltfMeshHandle | null = null;
        private planet: NriGltfMeshHandle | null = null;
        private instanceBuffer: NriBufferHandle | null = null;
        private rockTextures: NriTextureHandle | null = null;
        private planetTexture: NriTextureHandle | null = null;
        private rockTexturesView: NriDescriptorHandle | null = null;
        private planetTextureView: NriDescriptorHandle | null = null;
        private anisotropicWrap: NriDescriptorHandle | null = null;
        private linearClamp: NriDescriptorHandle | null = null;
        private colorBuffer: NriTextureHandle | null = null;
        private colorAttachment: NriDescriptorHandle | null = null;
        private colorView: NriDescriptorHandle | null = null;
        private depthTexture: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private constantBuffer: NriBufferHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private blitSet: NriDescriptorSetHandle | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;

        private camera: ThirdPersonCamera = new ThirdPersonCamera();
        private paused: boolean = false;
        private pausePressed: boolean = false;

        // -noUI: no overlay.
        noUI: boolean = false;

        // The UBO contents (locSpeed and globSpeed advance each frame), and the blit's constants.
        private constants: f32[] = [];
        private blitConstants: f32[] = [0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
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

            // Swap chain: blitted into through sRGB views, as the Donut example's sRGB back buffer.
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

            // The models and textures, the textures as sRGB (as the sample, vkb, loads KTX 1 color
            // textures); the rock instances.
            this.rock = Nri_LoadGltfMesh(device, this.queue, ROCK_PATH);
            this.planet = Nri_LoadGltfMesh(device, this.queue, PLANET_PATH);
            const rockTextures = Nri_LoadDdsTexture(device, this.queue, ROCK_TEXTURES_PATH, 1);
            const planetTexture = Nri_LoadDdsTexture(device, this.queue, PLANET_TEXTURE_PATH, 1);
            this.rockTextures = rockTextures;
            this.planetTexture = planetTexture;
            if (!this.modelsLoaded() || !rockTextures || !planetTexture) {
                console.log("Cannot load the models and textures: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            const rockTexturesView = Nri_CreateTextureArrayView(rockTextures, NriFormat.RGBA8_SRGB);
            const planetTextureView = Nri_CreateTextureView(planetTexture, NriFormat.RGBA8_SRGB);
            this.rockTexturesView = rockTexturesView;
            this.planetTextureView = planetTextureView;
            this.instanceBuffer = this.createInstanceBuffer(device);

            // Donut's common samplers: anisotropic and repeating for the models' textures, linear and
            // clamped for the blit.
            const anisotropicWrap = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.Repeat,
                Math.min(16, Nri_GetMaxSamplerAnisotropy(device)));
            const linearClamp = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
            this.anisotropicWrap = anisotropicWrap;
            this.linearClamp = linearClamp;
            if (!this.instanceBuffer || !anisotropicWrap || !linearClamp) {
                console.log("Cannot create the instance buffer and samplers");
                return 0;
            }

            // The color buffer (RGBA8, as the Donut example's) and the depth buffer, the swap chain's
            // size.
            const colorBuffer = Nri_CreateRenderTargetTexture(device, this.queue, this.width, this.height, NriFormat.RGBA8_UNORM);
            const depthTexture = Nri_CreateDepthTexture(device, this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.colorBuffer = colorBuffer;
            this.depthTexture = depthTexture;
            if (!colorBuffer || !depthTexture) {
                console.log("Cannot create the color and depth buffers");
                return 0;
            }
            this.colorAttachment = Nri_CreateColorAttachmentView(colorBuffer, NriFormat.RGBA8_UNORM);
            const colorView = Nri_CreateTextureView(colorBuffer, NriFormat.RGBA8_UNORM);
            this.colorView = colorView;
            this.depthAttachment = Nri_CreateDepthAttachmentView(depthTexture, NriFormat.D32_SFLOAT);

            // The layouts: the models' UBO (b0), texture (t0) and sampler (s0); the blit's constants
            // (b0) and its source (t0, s0).
            const meshLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(meshLayoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(meshLayoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(meshLayoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            const meshLayout = Nri_CreatePipelineLayoutFromDesc(device, meshLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(meshLayoutDesc);
            this.meshLayout = meshLayout;
            const blitLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(blitLayoutDesc, 0, BLIT_CONSTANT_FLOATS * 4, NriStage.Vertex);
            Nri_PipelineLayoutDescAddRange(blitLayoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(blitLayoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            const blitLayout = Nri_CreatePipelineLayoutFromDesc(device, blitLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(blitLayoutDesc);
            this.blitLayout = blitLayout;
            if (!meshLayout || !blitLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The pipelines: instancing.hlsl's shaders, as compiled for the Donut example; Donut's
            // blit shaders (rect_vs, blit_ps), as Donut compiles them.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : (graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv");
            const shaders = `shaders/instancing/${folder}/instancing`;
            this.rocksPipeline = this.createMeshPipeline(device, meshLayout, shaders, "instancing", true);
            this.planetPipeline = this.createMeshPipeline(device, meshLayout, shaders, "planet", false);
            this.starfieldPipeline = this.createStarfieldPipeline(device, meshLayout, shaders);
            this.blitPipeline = this.createBlitPipeline(device, blitLayout, `shaders/framework/${folder}`);
            if (!this.rocksPipeline || !this.planetPipeline || !this.starfieldPipeline || !this.blitPipeline) {
                console.log("Cannot load the instancing shaders");
                return 0;
            }

            // The UBO (a queued frame's each), the descriptor sets (a queued frame's two, and the
            // blit's).
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * CONST_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const descriptorPool = Nri_CreateDescriptorPool(device, 2 * queuedFrameNum + 1, 2 * queuedFrameNum + 1, 2 * queuedFrameNum,
                2 * queuedFrameNum + 1, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!constantBuffer || !descriptorPool || !colorView) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const uboView = Nri_CreateConstantBufferView(constantBuffer, i * CONST_STRIDE, CONST_STRIDE);
                const rocksSet = Nri_AllocateDescriptorSet(descriptorPool, meshLayout, 0, 0);
                const planetSet = Nri_AllocateDescriptorSet(descriptorPool, meshLayout, 0, 0);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), rocksSet, planetSet,
                    uboView));
                if (!uboView || !rocksSet || !planetSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(rocksSet, 0, 0, uboView);
                Nri_UpdateDescriptor(rocksSet, 1, 0, rockTexturesView);
                Nri_UpdateDescriptor(rocksSet, 2, 0, anisotropicWrap);
                Nri_UpdateDescriptor(planetSet, 0, 0, uboView);
                Nri_UpdateDescriptor(planetSet, 1, 0, planetTextureView);
                Nri_UpdateDescriptor(planetSet, 2, 0, anisotropicWrap);
            }
            const blitSet = Nri_AllocateDescriptorSet(descriptorPool, blitLayout, 0, 0);
            this.blitSet = blitSet;
            if (!blitSet) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }
            Nri_UpdateDescriptor(blitSet, 0, 0, colorView);
            Nri_UpdateDescriptor(blitSet, 1, 0, linearClamp);

            this.lookFromSampleCamera();

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

        // Both models were loaded.
        modelsLoaded(): boolean {
            if (!this.rock) {
                return false;
            }
            return this.planet ? true : false;
        }

        // The sample's prepare_instance_data: the rocks distributed randomly on two rings, half on
        // each, uploaded once (as the Donut example draws the random numbers).
        createInstanceBuffer(device: NriDeviceHandle) {
            const instanceData: f32[] = [];
            for (let i = 0; i < INSTANCE_COUNT * INSTANCE_FLOATS; i++) {
                instanceData.push(0.0);
            }

            const ringRadii = [7.0, 11.0, 14.0, 18.0];
            for (let i = 0; i < INSTANCE_COUNT / 2; i++) {
                // Inner ring, then outer ring.
                for (let ring = 0; ring < 2; ring++) {
                    const innerRadius = ringRadii[ring * 2];
                    const outerRadius = ringRadii[ring * 2 + 1];
                    const instance = (i + ring * INSTANCE_COUNT / 2) * INSTANCE_FLOATS;

                    const rho = Math.sqrt((outerRadius * outerRadius - innerRadius * innerRadius) * randomFloat()
                        + innerRadius * innerRadius);
                    const theta = 2.0 * Math.PI * randomFloat();
                    instanceData[instance + 0] = rho * Math.cos(theta);
                    instanceData[instance + 1] = randomFloat() * 0.5 - 0.25;
                    instanceData[instance + 2] = rho * Math.sin(theta);
                    instanceData[instance + 3] = Math.PI * randomFloat();
                    instanceData[instance + 4] = Math.PI * randomFloat();
                    instanceData[instance + 5] = Math.PI * randomFloat();
                    instanceData[instance + 6] = (1.5 + randomFloat() - randomFloat()) * 0.75;
                    // A layer of the texture array (the sample's distribution also picks one past the
                    // last layer, which the sampler clamps to it).
                    const layer: int = Math.min(Math.floor(randomFloat() * ROCK_TEXTURE_LAYERS), ROCK_TEXTURE_LAYERS - 1);
                    Nri_StoreInt32(Ref(instanceData[instance + 7]), layer);
                }
            }

            return Nri_CreateUploadedBuffer(device, this.queue, Ref(instanceData[0]), INSTANCE_COUNT * INSTANCE_SIZE,
                NriBufferUsage.VertexBuffer);
        }

        // The rocks and the planet: the models' vertices (and for the rocks, the instance data at
        // per-instance rate, stream 1), reversed depth (greater passes), back faces culled.
        createMeshPipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, shaders: string, name: string, instanced: boolean) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_${name}_vs.bin`, `${name}_vs`) != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_${name}_ps.bin`, `${name}_ps`) != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescAddVertexAttribute(desc, "NORMAL", NriFormat.RGB32_SFLOAT, 12);
            Nri_PipelineDescAddVertexAttribute(desc, "TEXCOORD", NriFormat.RG32_SFLOAT, 24);
            if (instanced) {
                Nri_PipelineDescAddVertexAttributeFromStream(desc, "INSTANCE_POSITION", NriFormat.RGB32_SFLOAT, 0, 1);
                Nri_PipelineDescAddVertexAttributeFromStream(desc, "INSTANCE_ROTATION", NriFormat.RGB32_SFLOAT, 12, 1);
                Nri_PipelineDescAddVertexAttributeFromStream(desc, "INSTANCE_SCALE", NriFormat.R32_SFLOAT, 24, 1);
                Nri_PipelineDescAddVertexAttributeFromStream(desc, "INSTANCE_TEXINDEX", NriFormat.R32_SINT, 28, 1);
                Nri_PipelineDescSetInstanceStream(desc, 1);
            }
            Nri_PipelineDescSetCullMode(desc, NriCullMode.Back);
            Nri_PipelineDescSetColor(desc, NriFormat.RGBA8_UNORM, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.Greater, 1, 0);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // The star field: a full screen triangle behind everything, without depth or bindings.
        createStarfieldPipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, shaders: string) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_starfield_vs.bin`, "starfield_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_starfield_ps.bin`, "starfield_ps") != 0;
            }
            Nri_PipelineDescSetColor(desc, NriFormat.RGBA8_UNORM, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.None, 0, 0);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // Donut's blit pipeline: rect_vs's quad (a triangle strip), blit_ps without texture arrays,
        // no culling, no depth.
        createBlitPipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, framework: string) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${framework}/rect_vs.bin`, "main") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShaderPermutation(desc, NriShaderStage.Pixel, `${framework}/blit_ps.bin`, "main",
                    "TEXTURE_ARRAY=0") != 0;
            }
            Nri_PipelineDescSetTopology(desc, NriTopology.TriangleStrip);
            Nri_PipelineDescSetColor(desc, this.viewFormat, NriColorWrite.RGBA);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // The sample's look-at camera, rotated (-17.2, -4.7) degrees and translated by
        // (5.5, -1.85, -18.5): its view matrix is T * Rx * Ry. The orbit camera starts at its position,
        // looking at the point 18.5 ahead (as far ahead as the world's origin is), in Donut's world
        // (y negated: see writeConstants), as the Donut example places it.
        lookFromSampleCamera() {
            const ca = Math.cos(radiansF32(-17.2));
            const sa = Math.sin(radiansF32(-17.2));
            const cb = Math.cos(radiansF32(-4.7));
            const sb = Math.sin(radiansF32(-4.7));
            // R = Rx * Ry (glm::rotate, column vectors), row by row.
            const r = [
                cb,       0.0, sb,
                sa * sb,  ca,  -sa * cb,
                -ca * sb, sa,  ca * cb,
            ];
            const t = [5.5, -1.85, -18.5];
            const distance = 18.5;

            // The camera's position, -R^T * t, and its forward direction, R^T * (0, 0, -1).
            const position: number[] = [];
            const target: number[] = [];
            for (let k = 0; k < 3; k++) {
                const p = -(r[k] * t[0] + r[3 + k] * t[1] + r[6 + k] * t[2]);
                const forward = -r[6 + k];
                position.push(p);
                target.push(p + forward * distance);
            }
            this.camera.lookAt(position[0], -position[1], position[2], target[0], -target[1], target[2]);
        }

        // Waits for the frame that last used this frame's command allocator (and its UBO).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The Donut example's onKey, onMouse* and onAnimate: P pauses; the orbit camera (unless the
        // overlay has the mouse); the sample's update_uniform_buffer: the rocks spin, and the rings
        // turn slowly (Donut's test mode: 1/60 s a frame, as a float).
        animate() {
            const pPressed = Nri_IsKeyPressed(this.sample, KEY_P) != 0;
            if (pPressed && !this.pausePressed) {
                this.paused = !this.paused;
            }
            this.pausePressed = pPressed;

            const overlay = this.imgui && Nri_ImguiWantsMouse() != 0;
            if (!overlay) {
                const orbiting = Nri_IsButtonPressed(this.sample, 0) != 0;
                this.camera.orbit(orbiting ? Nri_GetMouseDeltaX(this.sample) : 0.0, orbiting ? Nri_GetMouseDeltaY(this.sample) : 0.0,
                    Nri_GetMouseWheel(this.sample));
            }
            this.camera.animate();

            const elapsedSeconds = this.test ? Math.fround(1.0 / 60.0) : Nri_GetFrameTime(this.sample);
            if (!this.paused) {
                this.constants[CONST_LOC_SPEED] += elapsedSeconds * 0.35;
                this.constants[CONST_GLOB_SPEED] += elapsedSeconds * 0.01;
            }
        }

        // The sample's overlay.
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPos(10.0, 10.0);
            Nri_ImguiBegin("Statistics", 1);
            Nri_ImguiText(`Instances: ${INSTANCE_COUNT}`);
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        // The view and projection of the UBO, into this frame's slice; locSpeed and globSpeed advance
        // in animate.
        writeConstants(constantBuffer: NriBufferHandle, offset: int) {
            const c = this.constants;
            const projection = perspProjReverse(radiansF32(60.0), this.width / this.height, Z_NEAR, Z_FAR);
            const view = this.camera.worldToView;

            // The sample's world has -y up on the screen (Vulkan, without a flipped viewport). Mirrored
            // in y it is Donut's world, y up, with the same picture: Donut's view space is left-handed,
            // the sample's right-handed.
            for (let i = 0; i < 16; i++) {
                const row = Math.floor(i / 4);
                c[CONST_MODELVIEW + i] = row == 1 ? -view[i] : view[i];
                c[CONST_PROJECTION + i] = projection[i];
            }

            c[CONST_LIGHT_POS + 0] = 0.0;
            c[CONST_LIGHT_POS + 1] = -5.0;
            c[CONST_LIGHT_POS + 2] = 0.0;
            c[CONST_LIGHT_POS + 3] = 1.0;
            Nri_WriteBuffer(constantBuffer, offset, Ref(c[0]), CONST_FLOATS * 4);
        }

        // The star field, the planet, the instanced rocks (between Nri_CmdBeginRenderingWithDepth and
        // Nri_CmdEndRendering).
        recordScene(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const meshLayout = this.meshLayout;
            const descriptorPool = this.descriptorPool;
            const rocksPipeline = this.rocksPipeline;
            const planetPipeline = this.planetPipeline;
            const starfieldPipeline = this.starfieldPipeline;
            const rocksSet = queuedFrame.rocksSet;
            const planetSet = queuedFrame.planetSet;
            const rock = this.rock;
            const planet = this.planet;
            const instanceBuffer = this.instanceBuffer;
            if (!meshLayout || !descriptorPool || !rocksPipeline || !planetPipeline || !starfieldPipeline || !rocksSet || !planetSet) {
                return;
            }
            if (!rock || !planet || !instanceBuffer) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, meshLayout);

            // Star field
            Nri_CmdSetPipeline(commandBuffer, starfieldPipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, planetSet);
            Nri_CmdDraw(commandBuffer, 3, 1, 0, 0);

            // Planet
            Nri_CmdSetPipeline(commandBuffer, planetPipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, planetSet);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, Nri_GetGltfMeshVertexBuffer(planet), 0, VERTEX_SIZE);
            Nri_CmdSetIndexBuffer(commandBuffer, Nri_GetGltfMeshIndexBuffer(planet), 0, NriIndexType.UInt32);
            Nri_CmdDrawIndexed(commandBuffer, Nri_GetGltfMeshIndexCount(planet), 1, 0, 0, 0);

            // Instanced rocks: binding point 0, the mesh's vertices; 1, the instance data
            Nri_CmdSetPipeline(commandBuffer, rocksPipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, rocksSet);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, Nri_GetGltfMeshVertexBuffer(rock), 0, VERTEX_SIZE);
            Nri_CmdSetVertexBuffer(commandBuffer, 1, instanceBuffer, 0, INSTANCE_SIZE);
            Nri_CmdSetIndexBuffer(commandBuffer, Nri_GetGltfMeshIndexBuffer(rock), 0, NriIndexType.UInt32);
            Nri_CmdDrawIndexed(commandBuffer, Nri_GetGltfMeshIndexCount(rock), INSTANCE_COUNT, 0, 0, 0);
        }

        // The color buffer over the whole swap chain texture (between Nri_CmdBeginRendering and
        // Nri_CmdEndRendering), as Donut's BlitTexture draws it.
        recordBlit(commandBuffer: NriCommandBufferHandle) {
            const blitLayout = this.blitLayout;
            const blitPipeline = this.blitPipeline;
            const descriptorPool = this.descriptorPool;
            const blitSet = this.blitSet;
            if (!blitLayout || !blitPipeline || !descriptorPool || !blitSet) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, blitLayout);
            Nri_CmdSetPipeline(commandBuffer, blitPipeline);
            Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.blitConstants[0]), BLIT_CONSTANT_FLOATS * 4);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, blitSet);
            Nri_CmdDraw(commandBuffer, 4, 1, 0, 0);
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.animate();
            const constantBuffer = this.constantBuffer;
            if (constantBuffer) {
                this.writeConstants(constantBuffer, queuedFrameIndex * CONST_STRIDE);
            }

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            const colorBuffer = this.colorBuffer;
            const colorAttachment = this.colorAttachment;
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: the scene into the color buffer (the depth cleared to 0, the far plane of
                // reversed depth; the star field covers the color), the color buffer blitted into the
                // swap chain texture, the overlay over it.
                Nri_BeginCommandBuffer(commandBuffer);
                if (colorBuffer) {
                    Nri_CmdTextureBarrier(commandBuffer, colorBuffer, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
                    if (colorAttachment) {
                        if (depthAttachment) {
                            Nri_CmdBeginRenderingWithDepth(commandBuffer, colorAttachment, depthAttachment);
                            Nri_CmdClearDepth(commandBuffer, 0.0);
                            this.recordScene(commandBuffer, queuedFrame);
                            Nri_CmdEndRendering(commandBuffer);
                        }
                    }
                    Nri_CmdTextureBarrier(commandBuffer, colorBuffer, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
                }
                if (this.imgui) {
                    Nri_CmdCopyImguiData(this.sample, commandBuffer);
                }
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
                this.recordBlit(commandBuffer);
                if (this.imgui) {
                    Nri_CmdDrawImgui(this.sample, commandBuffer, this.viewFormat);
                }
                Nri_CmdEndRendering(commandBuffer);

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
                this.destroyDescriptor(this.rockTexturesView);
                this.destroyDescriptor(this.planetTextureView);
                this.destroyDescriptor(this.anisotropicWrap);
                this.destroyDescriptor(this.linearClamp);
                this.destroyDescriptor(this.colorAttachment);
                this.destroyDescriptor(this.colorView);
                this.destroyDescriptor(this.depthAttachment);
                this.destroyTexture(this.rockTextures);
                this.destroyTexture(this.planetTexture);
                this.destroyTexture(this.colorBuffer);
                this.destroyTexture(this.depthTexture);
                this.destroyMesh(this.rock);
                this.destroyMesh(this.planet);
                this.destroyBuffer(this.instanceBuffer);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.rocksPipeline);
                this.destroyPipeline(this.planetPipeline);
                this.destroyPipeline(this.starfieldPipeline);
                this.destroyPipeline(this.blitPipeline);
                this.destroyLayout(this.meshLayout);
                this.destroyLayout(this.blitLayout);
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

        destroyMesh(mesh: NriGltfMeshHandle | null) {
            if (mesh) {
                Nri_DestroyGltfMesh(mesh);
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

        destroyLayout(layout: NriPipelineLayoutHandle | null) {
            if (layout) {
                Nri_DestroyPipelineLayout(layout);
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const instancing = new Instancing(sample);
        // -noUI: no overlay.
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            if (Nri_GetArg(argc, argv, i) == "-noUI") {
                instancing.noUI = true;
            }
        }
        return instancing.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return InstancingNri.main(argc, argv);
}

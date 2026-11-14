/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { perspProjReverse, radiansF32 } from "../../core/matrix";
import { randomFloat } from "../../core/random";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriGltfMesh, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

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

    // NriDevice.loadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
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

    // A frame in flight's own data: its descriptor sets (the rocks'
    // and the planet's: the UBO's slice, a texture, the sampler) with the UBO's view.
    class QueuedFrame {
        constructor(public rocksSet: NriDescriptorSet | null, public planetSet: NriDescriptorSet | null,
            public uboView: NriDescriptor | null) {
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
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private meshLayout: NriPipelineLayout | null = null;
        private blitLayout: NriPipelineLayout | null = null;
        private rocksPipeline: NriPipeline | null = null;
        private planetPipeline: NriPipeline | null = null;
        private starfieldPipeline: NriPipeline | null = null;
        private blitPipeline: NriPipeline | null = null;
        private rock: NriGltfMesh | null = null;
        private planet: NriGltfMesh | null = null;
        private instanceBuffer: NriBuffer | null = null;
        private rockTextures: NriTexture | null = null;
        private planetTexture: NriTexture | null = null;
        private rockTexturesView: NriDescriptor | null = null;
        private planetTextureView: NriDescriptor | null = null;
        private anisotropicWrap: NriDescriptor | null = null;
        private linearClamp: NriDescriptor | null = null;
        private colorBuffer: NriTexture | null = null;
        private colorAttachment: NriDescriptor | null = null;
        private colorView: NriDescriptor | null = null;
        private depthTexture: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
        private constantBuffer: NriBuffer | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private blitSet: NriDescriptorSet | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views' (the swap chain's).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private swapChainViewFormat: NriFormat = NriFormat.Unknown;

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

            // Swap chain: blitted into through sRGB views, as the Donut example's sRGB back buffer.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.swapChainViewFormat;

            // The models and textures, the textures as sRGB (as the sample, vkb, loads KTX 1 color
            // textures); the rock instances.
            this.rock = device.loadGltfMesh(this.queue, ROCK_PATH);
            this.planet = device.loadGltfMesh(this.queue, PLANET_PATH);
            const rockTextures = device.loadDdsTexture(this.queue, ROCK_TEXTURES_PATH, 1);
            const planetTexture = device.loadDdsTexture(this.queue, PLANET_TEXTURE_PATH, 1);
            this.rockTextures = rockTextures;
            this.planetTexture = planetTexture;
            if (!this.modelsLoaded() || !rockTextures || !planetTexture) {
                console.log("Cannot load the models and textures: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            const rockTexturesView = rockTextures.createArrayView(NriFormat.RGBA8_SRGB);
            const planetTextureView = planetTexture.createView(NriFormat.RGBA8_SRGB);
            this.rockTexturesView = rockTexturesView;
            this.planetTextureView = planetTextureView;
            this.instanceBuffer = this.createInstanceBuffer(device);

            // Donut's common samplers: anisotropic and repeating for the models' textures, linear and
            // clamped for the blit.
            const anisotropicWrap = device.createSampler(NriFilter.Linear, NriAddressMode.Repeat,
                Math.min(16, device.getMaxSamplerAnisotropy()));
            const linearClamp = device.createSampler(NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
            this.anisotropicWrap = anisotropicWrap;
            this.linearClamp = linearClamp;
            if (!this.instanceBuffer || !anisotropicWrap || !linearClamp) {
                console.log("Cannot create the instance buffer and samplers");
                return 0;
            }

            // The color buffer (RGBA8, as the Donut example's) and the depth buffer, the swap chain's
            // size.
            if (!this.createSizeTargets(device)) {
                console.log("Cannot create the color and depth buffers");
                return 0;
            }
            const colorView = this.colorView;

            // The layouts: the models' UBO (b0), texture (t0) and sampler (s0); the blit's constants
            // (b0) and its source (t0, s0).
            const meshLayoutDesc = NriPipelineLayoutDesc.create();
            meshLayoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            meshLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            meshLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            const meshLayout = device.createPipelineLayoutFromDesc(meshLayoutDesc);
            meshLayoutDesc.destroy();
            this.meshLayout = meshLayout;
            const blitLayoutDesc = NriPipelineLayoutDesc.create();
            blitLayoutDesc.addRootConstants(0, BLIT_CONSTANT_FLOATS * 4, NriStage.Vertex);
            blitLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            blitLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            const blitLayout = device.createPipelineLayoutFromDesc(blitLayoutDesc);
            blitLayoutDesc.destroy();
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
            const constantBuffer = device.createHostBuffer(queuedFrameNum * CONST_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const descriptorPool = device.createDescriptorPool(2 * queuedFrameNum + 1, 2 * queuedFrameNum + 1, 2 * queuedFrameNum,
                2 * queuedFrameNum + 1, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!constantBuffer || !descriptorPool || !colorView) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const uboView = constantBuffer.createConstantView(i * CONST_STRIDE, CONST_STRIDE);
                const rocksSet = descriptorPool.allocateDescriptorSet(meshLayout, 0, 0);
                const planetSet = descriptorPool.allocateDescriptorSet(meshLayout, 0, 0);
                this.queuedFrames.push(new QueuedFrame(rocksSet, planetSet,
                    uboView));
                if (!uboView || !rocksSet || !planetSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                rocksSet.updateDescriptor(0, 0, uboView);
                rocksSet.updateDescriptor(1, 0, rockTexturesView);
                rocksSet.updateDescriptor(2, 0, anisotropicWrap);
                planetSet.updateDescriptor(0, 0, uboView);
                planetSet.updateDescriptor(1, 0, planetTextureView);
                planetSet.updateDescriptor(2, 0, anisotropicWrap);
            }
            const blitSet = descriptorPool.allocateDescriptorSet(blitLayout, 0, 0);
            this.blitSet = blitSet;
            if (!blitSet) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }
            blitSet.updateDescriptor(0, 0, colorView);
            blitSet.updateDescriptor(1, 0, linearClamp);

            this.lookFromSampleCamera();

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
            if (!this.rock) {
                return false;
            }
            return this.planet ? true : false;
        }

        // The sample's prepare_instance_data: the rocks distributed randomly on two rings, half on
        // each, uploaded once (as the Donut example draws the random numbers).
        createInstanceBuffer(device: NriDevice) {
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
                    Nri.storeInt32(Ref(instanceData[instance + 7]), layer);
                }
            }

            return device.createUploadedBuffer(this.queue, Ref(instanceData[0]), INSTANCE_COUNT * INSTANCE_SIZE,
                NriBufferUsage.VertexBuffer);
        }

        // The rocks and the planet: the models' vertices (and for the rocks, the instance data at
        // per-instance rate, stream 1), reversed depth (greater passes), back faces culled.
        createMeshPipeline(device: NriDevice, layout: NriPipelineLayout, shaders: string, name: string, instanced: boolean) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_${name}_vs.bin`, `${name}_vs`) != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_${name}_ps.bin`, `${name}_ps`) != 0;
            }
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            desc.addVertexAttribute("NORMAL", NriFormat.RGB32_SFLOAT, 12);
            desc.addVertexAttribute("TEXCOORD", NriFormat.RG32_SFLOAT, 24);
            if (instanced) {
                desc.addVertexAttributeFromStream("INSTANCE_POSITION", NriFormat.RGB32_SFLOAT, 0, 1);
                desc.addVertexAttributeFromStream("INSTANCE_ROTATION", NriFormat.RGB32_SFLOAT, 12, 1);
                desc.addVertexAttributeFromStream("INSTANCE_SCALE", NriFormat.R32_SFLOAT, 24, 1);
                desc.addVertexAttributeFromStream("INSTANCE_TEXINDEX", NriFormat.R32_SINT, 28, 1);
                desc.setInstanceStream(1);
            }
            desc.setCullMode(NriCullMode.Back);
            desc.setColor(NriFormat.RGBA8_UNORM, NriColorWrite.RGBA);
            desc.setDepth(NriFormat.D32_SFLOAT, NriCompareOp.Greater, 1, 0);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        // The star field: a full screen triangle behind everything, without depth or bindings.
        createStarfieldPipeline(device: NriDevice, layout: NriPipelineLayout, shaders: string) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_starfield_vs.bin`, "starfield_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_starfield_ps.bin`, "starfield_ps") != 0;
            }
            desc.setColor(NriFormat.RGBA8_UNORM, NriColorWrite.RGBA);
            desc.setDepth(NriFormat.D32_SFLOAT, NriCompareOp.None, 0, 0);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        // Donut's blit pipeline: rect_vs's quad (a triangle strip), blit_ps without texture arrays,
        // no culling, no depth.
        createBlitPipeline(device: NriDevice, layout: NriPipelineLayout, framework: string) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${framework}/rect_vs.bin`, "main") != 0;
            if (loaded) {
                loaded = desc.addShaderPermutation(NriShaderStage.Pixel, `${framework}/blit_ps.bin`, "main",
                    "TEXTURE_ARRAY=0") != 0;
            }
            desc.setTopology(NriTopology.TriangleStrip);
            desc.setColor(this.viewFormat, NriColorWrite.RGBA);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
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
            this.frames.wait(frameIndex);
        }

        // The Donut example's onKey, onMouse* and onAnimate: P pauses; the orbit camera (unless the
        // overlay has the mouse); the sample's update_uniform_buffer: the rocks spin, and the rings
        // turn slowly (Donut's test mode: 1/60 s a frame, as a float).
        animate() {
            const pPressed = this.sample.isKeyPressed(KEY_P) != 0;
            if (pPressed && !this.pausePressed) {
                this.paused = !this.paused;
            }
            this.pausePressed = pPressed;

            const overlay = this.imgui && NriImgui.wantsMouse() != 0;
            if (!overlay) {
                const orbiting = this.sample.isButtonPressed(0) != 0;
                this.camera.orbit(orbiting ? this.sample.getMouseDeltaX() : 0.0, orbiting ? this.sample.getMouseDeltaY() : 0.0,
                    this.sample.getMouseWheel());
            }
            this.camera.animate();

            const elapsedSeconds = this.test ? Math.fround(1.0 / 60.0) : this.sample.getFrameTime();
            if (!this.paused) {
                this.constants[CONST_LOC_SPEED] += elapsedSeconds * 0.35;
                this.constants[CONST_GLOB_SPEED] += elapsedSeconds * 0.01;
            }
        }

        // The sample's overlay.
        buildUI() {
            this.sample.imguiNewFrame();
            NriImgui.setNextWindowPos(10.0, 10.0);
            NriImgui.begin("Statistics", 1);
            NriImgui.text(`Instances: ${INSTANCE_COUNT}`);
            NriImgui.end();
            this.sample.imguiRender();
        }

        // The view and projection of the UBO, into this frame's slice; locSpeed and globSpeed advance
        // in animate.
        writeConstants(constantBuffer: NriBuffer, offset: int) {
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
            constantBuffer.write(offset, Ref(c[0]), CONST_FLOATS * 4);
        }

        // The star field, the planet, the instanced rocks (between NriCommandBuffer.beginRenderingWithDepth and
        // NriCommandBuffer.endRendering).
        recordScene(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
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
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(meshLayout);

            // Star field
            commandBuffer.setPipeline(starfieldPipeline);
            commandBuffer.setDescriptorSet(0, planetSet);
            commandBuffer.draw(3, 1, 0, 0);

            // Planet
            commandBuffer.setPipeline(planetPipeline);
            commandBuffer.setDescriptorSet(0, planetSet);
            commandBuffer.setVertexBuffer(0, planet.getVertexBuffer(), 0, VERTEX_SIZE);
            commandBuffer.setIndexBuffer(planet.getIndexBuffer(), 0, NriIndexType.UInt32);
            commandBuffer.drawIndexed(planet.getIndexCount(), 1, 0, 0, 0);

            // Instanced rocks: binding point 0, the mesh's vertices; 1, the instance data
            commandBuffer.setPipeline(rocksPipeline);
            commandBuffer.setDescriptorSet(0, rocksSet);
            commandBuffer.setVertexBuffer(0, rock.getVertexBuffer(), 0, VERTEX_SIZE);
            commandBuffer.setVertexBuffer(1, instanceBuffer, 0, INSTANCE_SIZE);
            commandBuffer.setIndexBuffer(rock.getIndexBuffer(), 0, NriIndexType.UInt32);
            commandBuffer.drawIndexed(rock.getIndexCount(), INSTANCE_COUNT, 0, 0, 0);
        }

        // The color buffer over the whole swap chain texture (between NriCommandBuffer.beginRendering and
        // NriCommandBuffer.endRendering), as Donut's BlitTexture draws it.
        recordBlit(commandBuffer: NriCommandBuffer) {
            const blitLayout = this.blitLayout;
            const blitPipeline = this.blitPipeline;
            const descriptorPool = this.descriptorPool;
            const blitSet = this.blitSet;
            if (!blitLayout || !blitPipeline || !descriptorPool || !blitSet) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(blitLayout);
            commandBuffer.setPipeline(blitPipeline);
            commandBuffer.setRootConstants(0, Ref(this.blitConstants[0]), BLIT_CONSTANT_FLOATS * 4);
            commandBuffer.setDescriptorSet(0, blitSet);
            commandBuffer.draw(4, 1, 0, 0);
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain made
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
            this.destroySizeTargets();
            this.swapChain.recreate();
            this.sizeToSwapChain();
            this.createSizeTargets(device);
            // The blit reads the new color buffer.
            const blitSet = this.blitSet;
            const colorView = this.colorView;
            if (blitSet) {
                if (colorView) {
                    blitSet.updateDescriptor(0, 0, colorView);
                }
            }
        }

        // The color buffer (RGBA8) and the depth buffer at the swap chain's size. False if either
        // can't be created.
        createSizeTargets(device: NriDevice): boolean {
            const colorBuffer = device.createRenderTargetTexture(this.queue, this.width, this.height, NriFormat.RGBA8_UNORM);
            const depthTexture = device.createDepthTexture(this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.colorBuffer = colorBuffer;
            this.depthTexture = depthTexture;
            if (!colorBuffer || !depthTexture) {
                return false;
            }
            this.colorAttachment = colorBuffer.createColorAttachmentView(NriFormat.RGBA8_UNORM);
            this.colorView = colorBuffer.createView(NriFormat.RGBA8_UNORM);
            this.depthAttachment = depthTexture.createDepthAttachmentView(NriFormat.D32_SFLOAT);
            return true;
        }

        destroySizeTargets() {
            this.destroyDescriptor(this.colorAttachment);
            this.destroyDescriptor(this.colorView);
            this.destroyDescriptor(this.depthAttachment);
            this.destroyTexture(this.colorBuffer);
            this.destroyTexture(this.depthTexture);
            this.colorAttachment = null;
            this.colorView = null;
            this.depthAttachment = null;
            this.colorBuffer = null;
            this.depthTexture = null;
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
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
            const index = this.swapChain.acquire(frameIndex);
            const colorBuffer = this.colorBuffer;
            const colorAttachment = this.colorAttachment;
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: the scene into the color buffer (the depth cleared to 0, the far plane of
                // reversed depth; the star field covers the color), the color buffer blitted into the
                // swap chain texture, the overlay over it.
                commandBuffer.begin();
                if (colorBuffer) {
                    commandBuffer.textureBarrier(colorBuffer, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
                    if (colorAttachment) {
                        if (depthAttachment) {
                            commandBuffer.beginRenderingWithDepth(colorAttachment, depthAttachment);
                            commandBuffer.clearDepth(0.0);
                            this.recordScene(commandBuffer, queuedFrame);
                            commandBuffer.endRendering();
                        }
                    }
                    commandBuffer.textureBarrier(colorBuffer, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
                }
                if (this.imgui) {
                    this.sample.copyImguiData(commandBuffer);
                }
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                this.recordBlit(commandBuffer);
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
                    this.destroyDescriptor(queuedFrame.uboView);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
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
        const instancing = new Instancing(sample);
        // -noUI: no overlay.
        sample.addExampleOption("-noUI");
        sample.useImgui();
        for (let i = 1; i < argc; i++) {
            if (Nri.getArg(argc, argv, i) == "-noUI") {
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

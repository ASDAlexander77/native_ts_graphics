/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { radiansF32 } from "../../core/matrix";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriGltfMesh, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace HdrNri {
    // hdr, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut and NVRHI:
    // the same shaders (hdr.hlsl's), models (read as Donut's loadGltfMesh reads them) and cube map,
    // through the NRI calls core/nri/nri_interop.d.ts binds, with NRIFramework's ImGui for the
    // sample's overlay. This example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: High Dynamic Range Rendering";

    // The sample's models and HDR cube map (Vulkan-Samples' assets), the KTX cube map converted to
    // DDS at build time (see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const SKYBOX_PATH = "media/hdr/cube.gltf";
    const OBJECT_PATHS = ["media/hdr/geosphere.gltf", "media/hdr/teapot.gltf", "media/hdr/torusknot.gltf"];
    const OBJECT_NAMES = "Sphere|Teapot|Torusknot";
    const ENVMAP_PATH = "media/hdr/uffizi_rgba16f_cube.dds";

    // NriDevice.loadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;
    const NORMAL_OFFSET = 12;

    // struct UBOMatrices, as f32 offsets (HLSL packing); a queued frame's in a constant buffer view
    // of MATRICES_VIEW_SIZE bytes, then its UBOParams { float exposure; } in one of PARAMS_VIEW_SIZE
    // (multiples of 256, D3D12's).
    const CONST_PROJECTION = 0;
    const CONST_MODELVIEW = 16;
    const CONST_SKYBOX_MODELVIEW = 32;
    const CONST_INVERSE_MODELVIEW = 48;
    const CONST_MODELSCALE = 64;
    const CONST_FLOATS = 68;
    const PARAMS_EXPOSURE = 0;
    const PARAMS_FLOATS = 4;
    const MATRICES_VIEW_SIZE = 512;
    const PARAMS_VIEW_SIZE = 256;
    const CONST_STRIDE = MATRICES_VIEW_SIZE + PARAMS_VIEW_SIZE;

    // The sample's camera: reversed depth from 0.1 to 256.
    const Z_NEAR = 0.1;
    const Z_FAR = 256.0;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into: its command buffer, the models' descriptor set (its
    // slices of the constants, the cube map and its sampler) and the views of its slices.
    class QueuedFrame {
        constructor(public commandBuffer: NriCommandBuffer,
            public modelsSet: NriDescriptorSet | null, public matricesView: NriDescriptor | null,
            public paramsView: NriDescriptor | null) {
        }
    }

    // A render target and its views: rendered into and read by shaders.
    class Target {
        constructor(public texture: NriTexture, public attachment: NriDescriptor, public shaderResource: NriDescriptor) {
        }
    }

    // -test: checks the last frame, read back, as the Donut example does: the street skybox, tone
    // mapped from HDR with bloom, about 97% lit (some channel over 20), the sky and the sphere's
    // highlights about 3.6% white (every channel over 220).
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const total = width * height;
        let dark = 0;
        let white = 0;
        for (let i = 0; i < total; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r <= 20 && g <= 20 && b <= 20) {
                dark++;
            }
            if (r >= 221 && g >= 221 && b >= 221) {
                white++;
            }
        }
        const lit = 100.0 * (total - dark) / total;
        console.log(`Lit: ${lit}% (${total - dark} of ${total} pixels)`);
        if (lit < 92.0 || lit > 100.0) {
            return `Lit: ${lit}% of the pixels, not 92% to 100%`;
        }
        const whitePercent = 100.0 * white / total;
        console.log(`White: ${whitePercent}% (${white} of ${total} pixels)`);
        if (whitePercent < 2.0 || whitePercent > 6.0) {
            return `White: ${whitePercent}% of the pixels, not 2% to 6%`;
        }
        return "";
    }

    // The sample's glm::perspective(fov, aspect, 256, 0.1) (near and far swapped for reversed
    // depth; right-handed, depth from 0 to 1), for row vectors, with clip y negated: the sample's
    // clip space has y down on the screen (Vulkan's), Donut's y up (as the Donut example gives it).
    // In float32, in glm's order of operations.
    function samplePerspective(verticalFOV: number, aspect: number, zNear: number, zFar: number) {
        const tanHalfFovy = Math.fround(Math.tan(Math.fround(Math.fround(verticalFOV) / 2.0)));
        // glm's near and far, swapped.
        const n = Math.fround(zFar);
        const f = Math.fround(zNear);
        return [
            Math.fround(1.0 / Math.fround(Math.fround(aspect) * tanHalfFovy)), 0.0, 0.0, 0.0,
            0.0, -Math.fround(1.0 / tanHalfFovy), 0.0, 0.0,
            0.0, 0.0, Math.fround(f / Math.fround(n - f)), -1.0,
            0.0, 0.0, Math.fround(-Math.fround(f * n) / Math.fround(f - n)), 0.0,
        ];
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
    // (instancing_nri's port).
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

    // Port of Vulkan-Samples' hdr (as examples/hdr.ts ports it) to NRI: a reflective object in front
    // of an HDR environment cube map, rendered to two float targets: the colors with an exposure
    // applied, and their bright parts. The bright parts are blurred in two passes, the first into a
    // filter target, the second added over the colors as they are copied to the (sRGB) swap chain
    // texture.
    class Hdr {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        // The swap chain textures' format (the readback's).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private viewFormat: NriFormat = NriFormat.Unknown;
        private modelsLayout: NriPipelineLayout | null = null;
        private postLayout: NriPipelineLayout | null = null;
        private skyboxPipeline: NriPipeline | null = null;
        private reflectPipeline: NriPipeline | null = null;
        private bloomFilterPipeline: NriPipeline | null = null;
        private compositionPipeline: NriPipeline | null = null;
        private bloomCompositePipeline: NriPipeline | null = null;
        private skybox: NriGltfMesh | null = null;
        private objects: NriGltfMesh[] = [];
        private envmap: NriTexture | null = null;
        private envmapView: NriDescriptor | null = null;
        private anisotropicSampler: NriDescriptor | null = null;
        private pointSampler: NriDescriptor | null = null;
        private constantBuffer: NriBuffer | null = null;
        // The offscreen targets (two RGBA32F colors and a D32 depth) and the bloom filter's target,
        // for the window's size.
        private offscreenColor0: Target | null = null;
        private offscreenColor1: Target | null = null;
        private filterColor: Target | null = null;
        private depthTexture: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        // The fullscreen passes' sets: the first bloom pass reads the colors and their bright parts,
        // the composition and the second bloom pass the colors and the filter target.
        private bloomFilterSet: NriDescriptorSet | null = null;
        private compositionSet: NriDescriptorSet | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;

        private camera: ThirdPersonCamera = new ThirdPersonCamera();

        // The sample's settings (-object <0..2>, -exposure <value>, -nobloom, -noskybox); -noUI: no
        // overlay.
        objectIndex: int = 0;
        exposure: number = 1.0;
        bloom: boolean = true;
        displaySkybox: boolean = true;
        noUI: boolean = false;

        // The UBO contents.
        private matrices: f32[] = [];
        private params: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        // Whether the filter target has been cleared once (initializeTargets).
        private targetsInitialized: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.matrices.push(0.0);
            }
            for (let i = 0; i < PARAMS_FLOATS; i++) {
                this.params.push(0.0);
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
            const viewFormat = this.viewFormat;

            // The models and the HDR cube map (as is).
            this.skybox = device.loadGltfMesh(this.queue, SKYBOX_PATH);
            let objectsLoaded = true;
            if (!this.skybox) {
                objectsLoaded = false;
            }
            for (const objectPath of OBJECT_PATHS) {
                const mesh = device.loadGltfMesh(this.queue, objectPath);
                if (!mesh) {
                    objectsLoaded = false;
                } else {
                    this.objects.push(mesh);
                }
            }
            const envmap = device.loadDdsTexture(this.queue, ENVMAP_PATH, 0);
            this.envmap = envmap;
            if (!objectsLoaded || !envmap) {
                console.log("Cannot load the models and the cube map: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            const envmapView = envmap.createCubeView(NriFormat.RGBA16_SFLOAT);
            this.envmapView = envmapView;
            // Donut's AnisotropicWrap (trilinear, the device's maximum anisotropy), for the cube map;
            // its PointClamp, as the sample's offscreen sampler (nearest, clamped), for the targets.
            const anisotropicSampler = device.createSamplerWithMipFilter(NriFilter.Linear, NriFilter.Linear, NriAddressMode.Repeat,
                device.getMaxSamplerAnisotropy());
            const pointSampler = device.createSamplerWithMipFilter(NriFilter.Nearest, NriFilter.Nearest, NriAddressMode.ClampToEdge, 1);
            this.anisotropicSampler = anisotropicSampler;
            this.pointSampler = pointSampler;

            // The models' layout: the matrices (b0) and the params (b1), the cube map (t0) and its
            // sampler (s0). The fullscreen passes': two textures (t0, t1) and a sampler (s0).
            const modelsLayoutDesc = NriPipelineLayoutDesc.create();
            modelsLayoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            modelsLayoutDesc.addRange(0, 1, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            modelsLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.VertexPixel, NriRangeFlags.None);
            modelsLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.VertexPixel, NriRangeFlags.None);
            this.modelsLayout = device.createPipelineLayoutFromDesc(modelsLayoutDesc);
            modelsLayoutDesc.destroy();

            const postLayoutDesc = NriPipelineLayoutDesc.create();
            postLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.VertexPixel, NriRangeFlags.None);
            postLayoutDesc.addRange(0, 1, 1, NriDescriptorType.Texture, NriStage.VertexPixel, NriRangeFlags.None);
            postLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.VertexPixel, NriRangeFlags.None);
            this.postLayout = device.createPipelineLayoutFromDesc(postLayoutDesc);
            postLayoutDesc.destroy();

            const modelsLayout = this.modelsLayout;
            const postLayout = this.postLayout;
            if (!modelsLayout || !postLayout || !envmapView || !anisotropicSampler || !pointSampler) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The sample's pipelines: hdr.hlsl's shaders, as compiled for the Donut example.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : (graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv");
            const shaders = `shaders/hdr/${folder}/hdr`;
            // Skybox pipeline (background cube): no depth test or writes, back faces culled.
            this.skyboxPipeline = this.createModelPipeline(device, modelsLayout, shaders, "skybox", false);
            // Object rendering pipeline: depth tested (greater: reversed) and written, cull mode
            // flipped.
            this.reflectPipeline = this.createModelPipeline(device, modelsLayout, shaders, "reflect", true);
            // First blur pass, into the filter target (additive, as the sample's bloom pipelines).
            this.bloomFilterPipeline = this.createFullscreenPipeline(device, postLayout, shaders, "bloom_filter_ps", NriFormat.RGBA32_SFLOAT,
                true);
            // Final fullscreen composition pass, and the second blur pass added over it.
            this.compositionPipeline = this.createFullscreenPipeline(device, postLayout, shaders, "composition_ps", viewFormat, false);
            this.bloomCompositePipeline = this.createFullscreenPipeline(device, postLayout, shaders, "bloom_composite_ps", viewFormat, true);
            if (!this.skyboxPipeline || !this.reflectPipeline || !this.bloomFilterPipeline || !this.compositionPipeline
                || !this.bloomCompositePipeline) {
                console.log("Cannot load the hdr shaders");
                return 0;
            }

            // The sample's prepare_offscreen_buffer: two 128-bit RGBA floating point color buffers
            // and the depth buffer (D32, cleared to 0: reversed depth); the bloom filter's target.
            const sizeTargetsCreated = this.createSizeTargets(device);
            const offscreenColor0 = this.offscreenColor0;
            const offscreenColor1 = this.offscreenColor1;
            const filterColor = this.filterColor;
            if (!sizeTargetsCreated || !offscreenColor0 || !offscreenColor1 || !filterColor) {
                console.log("Cannot create the offscreen targets");
                return 0;
            }

            // The constants, a queued frame's each; a queued frame's models set, and the two
            // fullscreen passes' sets.
            const constantBuffer = device.createHostBuffer(queuedFrameNum * CONST_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const descriptorPool = device.createDescriptorPool(queuedFrameNum + 2, queuedFrameNum + 2, 2 * queuedFrameNum,
                queuedFrameNum + 4, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!constantBuffer || !descriptorPool) {
                console.log("Cannot create the constant buffer");
                return 0;
            }
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const matricesView = constantBuffer.createConstantView(i * CONST_STRIDE, MATRICES_VIEW_SIZE);
                const paramsView = constantBuffer.createConstantView(i * CONST_STRIDE + MATRICES_VIEW_SIZE, PARAMS_VIEW_SIZE);
                const modelsSet = descriptorPool.allocateDescriptorSet(modelsLayout, 0, 0);
                this.queuedFrames.push(new QueuedFrame(new NriCommandBuffer(this.frames.commandBuffer(i).handle), modelsSet, matricesView,
                    paramsView));
                if (!matricesView || !paramsView || !modelsSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                modelsSet.updateDescriptor(0, 0, matricesView);
                modelsSet.updateDescriptor(1, 0, paramsView);
                modelsSet.updateDescriptor(2, 0, envmapView);
                modelsSet.updateDescriptor(3, 0, anisotropicSampler);
            }
            this.bloomFilterSet = this.createPostSet(descriptorPool, postLayout, offscreenColor0, offscreenColor1, pointSampler);
            this.compositionSet = this.createPostSet(descriptorPool, postLayout, offscreenColor0, filterColor, pointSampler);
            if (!this.bloomFilterSet || !this.compositionSet) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }

            // The sample's look-at camera, at (0, 0, -4) and turned 180 degrees around y: looking at
            // the world's origin from (0, 0, -4), in either world (see updateConstants).
            this.camera.lookAt(0.0, 0.0, -4.0, 0.0, 0.0, 0.0);

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

        // The window-size targets: the offscreen colors, the bloom filter's target (shader resources
        // once made) and the depth buffer; false if one can't be made.
        createSizeTargets(device: NriDevice): boolean {
            this.offscreenColor0 = this.createTarget(device, NriFormat.RGBA32_SFLOAT);
            this.offscreenColor1 = this.createTarget(device, NriFormat.RGBA32_SFLOAT);
            this.filterColor = this.createTarget(device, NriFormat.RGBA32_SFLOAT);
            const depthTexture = device.createDepthTexture(this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!this.offscreenColor0 || !this.offscreenColor1 || !this.filterColor || !depthTexture) {
                return false;
            }
            this.depthAttachment = depthTexture.createDepthAttachmentView(NriFormat.D32_SFLOAT);
            return true;
        }

        destroySizeTargets() {
            this.destroyTarget(this.offscreenColor0);
            this.destroyTarget(this.offscreenColor1);
            this.destroyTarget(this.filterColor);
            this.destroyDescriptor(this.depthAttachment);
            this.destroyTexture(this.depthTexture);
            this.offscreenColor0 = null;
            this.offscreenColor1 = null;
            this.filterColor = null;
            this.depthAttachment = null;
            this.depthTexture = null;
        }

        // The window was resized (NriSample.useResizableWindow): once the GPU is done with them, the swap
        // chain and the window-size targets made again at its size, the fullscreen passes' sets
        // pointed at the new ones, and the new filter target cleared again before it is read.
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
            this.targetsInitialized = false;
            if (!this.createSizeTargets(device)) {
                return;
            }
            const offscreenColor0 = this.offscreenColor0;
            const offscreenColor1 = this.offscreenColor1;
            const filterColor = this.filterColor;
            const bloomFilterSet = this.bloomFilterSet;
            const compositionSet = this.compositionSet;
            if (!offscreenColor0 || !offscreenColor1 || !filterColor || !bloomFilterSet || !compositionSet) {
                return;
            }
            bloomFilterSet.updateDescriptor(0, 0, offscreenColor0.shaderResource);
            bloomFilterSet.updateDescriptor(1, 0, offscreenColor1.shaderResource);
            compositionSet.updateDescriptor(0, 0, offscreenColor0.shaderResource);
            compositionSet.updateDescriptor(1, 0, filterColor.shaderResource);
        }

        // A window-sized render target of format, left as a shader resource; null on failure.
        createTarget(device: NriDevice, format: NriFormat): Target | null {
            const texture = device.createRenderTargetTexture(this.queue, this.width, this.height, format);
            if (!texture) {
                return null;
            }
            return new Target(texture, texture.createColorAttachmentView(format), texture.createView(format));
        }

        // A fullscreen passes' set: texture0 at t0, texture1 at t1, the sampler at s0.
        createPostSet(descriptorPool: NriDescriptorPool, postLayout: NriPipelineLayout, texture0: Target, texture1: Target,
            sampler: NriDescriptor) {
            const set = descriptorPool.allocateDescriptorSet(postLayout, 0, 0);
            if (!set) {
                return null;
            }
            set.updateDescriptor(0, 0, texture0.shaderResource);
            set.updateDescriptor(1, 0, texture1.shaderResource);
            set.updateDescriptor(2, 0, sampler);
            return set;
        }

        // The skybox or the object, into the offscreen targets: position and normal of the glTF
        // loader's vertices; counter-clockwise front faces; the skybox without depth, back faces
        // culled; the object with depth tested (greater: reversed) and written, front faces culled.
        // The sample's projection keeps its framebuffer coordinates, so its cull modes too.
        createModelPipeline(device: NriDevice, layout: NriPipelineLayout, shaders: string, name: string, isObject: boolean) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_${name}_vs.bin`, `${name}_vs`) != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_${name}_ps.bin`, `${name}_ps`) != 0;
            }
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            desc.addVertexAttribute("NORMAL", NriFormat.RGB32_SFLOAT, NORMAL_OFFSET);
            desc.setCullMode(isObject ? NriCullMode.Front : NriCullMode.Back);
            desc.setFrontCounterClockwise(1);
            desc.setColor(NriFormat.RGBA32_SFLOAT, NriColorWrite.RGBA);
            desc.addColor(NriFormat.RGBA32_SFLOAT, NriColorWrite.RGBA);
            desc.setDepth(NriFormat.D32_SFLOAT, isObject ? NriCompareOp.Greater : NriCompareOp.None, isObject ? 1 : 0, 0);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        // A fullscreen pass's pipeline (fullscreen_vs and the pixel shader ps) into a color target of
        // format: additive (Donut's BlendMode.Additive) or not; no depth, no culling.
        createFullscreenPipeline(device: NriDevice, layout: NriPipelineLayout, shaders: string, ps: string, format: NriFormat,
            additive: boolean) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_fullscreen_vs.bin`, "fullscreen_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_${ps}.bin`, ps) != 0;
            }
            desc.setColor(format, NriColorWrite.RGBA);
            if (additive) {
                desc.setAdditiveBlend();
            }
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        // Waits for the frame that last used this frame's command allocator (and its UBO slices).
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The Donut example's onMouse* and onAnimate: the orbit camera (unless the overlay has the
        // mouse).
        animate() {
            const overlay = this.imgui && NriImgui.wantsMouse() != 0;
            if (!overlay) {
                const orbiting = this.sample.isButtonPressed(0) != 0;
                this.camera.orbit(orbiting ? this.sample.getMouseDeltaX() : 0.0, orbiting ? this.sample.getMouseDeltaY() : 0.0,
                    this.sample.getMouseWheel());
            }
            this.camera.animate();
        }

        // The sample's overlay.
        buildUI() {
            this.sample.imguiNewFrame();
            NriImgui.setNextWindowPos(10.0, 10.0);
            NriImgui.begin("High dynamic range rendering", 1);
            NriImgui.pushItemWidth(110.0);
            if (NriImgui.collapsingHeader("Settings", 1) != 0) {
                this.objectIndex = NriImgui.combo("Object type", this.objectIndex, OBJECT_NAMES);
                this.exposure = NriImgui.inputFloat("Exposure", this.exposure, 0.025, "%.3f");
                this.bloom = NriImgui.checkbox("Bloom", this.bloom ? 1 : 0) != 0;
                this.displaySkybox = NriImgui.checkbox("Skybox", this.displaySkybox ? 1 : 0) != 0;
            }
            NriImgui.popItemWidth();
            NriImgui.end();
            this.sample.imguiRender();
        }

        // The sample's update_uniform_buffers and update_params, into this frame's slices.
        updateConstants(constantBuffer: NriBuffer, offset: int) {
            const width = this.width;
            const height = this.height;
            const viewMatrix = this.camera.worldToView;

            // The sample's world has -y up on the screen (Vulkan, without a flipped viewport). Mirrored
            // in y it is Donut's world, y up, with the same picture: Donut's view space is left-handed,
            // the sample's right-handed. So the sample's view matrix is the y mirror, then Donut's
            // view, then Donut's view space to the sample's (y down, -z forward): rows and columns of
            // Donut's negated.
            const view: number[] = [];
            for (let i = 0; i < 16; i++) {
                const row = Math.floor(i / 4);
                const column = i % 4;
                const mirrored = row == 1 ? -viewMatrix[i] : viewMatrix[i];
                view.push(column == 1 || column == 2 ? -mirrored : mirrored);
            }

            // The objects' transforms: the teapot scaled by 10 and turned 180 degrees around x.
            const model = this.objectIndex == 1 ? [10.0, -10.0, -10.0, 1.0] : [1.0, 1.0, 1.0, 1.0];

            const c = this.matrices;
            const sampleProjection = samplePerspective(radiansF32(60.0), width / height, Z_NEAR, Z_FAR);
            for (let i = 0; i < 16; i++) {
                const row = Math.floor(i / 4);
                c[CONST_PROJECTION + i] = sampleProjection[i];
                c[CONST_MODELVIEW + i] = model[row] * view[i];
                c[CONST_SKYBOX_MODELVIEW + i] = view[i];
            }

            // inverse(view): the view is a rotation and a translation, so its rotation transposed and
            // the translation turned back.
            for (let row = 0; row < 3; row++) {
                for (let column = 0; column < 3; column++) {
                    c[CONST_INVERSE_MODELVIEW + row * 4 + column] = view[column * 4 + row];
                }
                c[CONST_INVERSE_MODELVIEW + row * 4 + 3] = 0.0;
            }
            for (let column = 0; column < 3; column++) {
                let t = 0.0;
                for (let k = 0; k < 3; k++) {
                    t -= view[12 + k] * view[column * 4 + k];
                }
                c[CONST_INVERSE_MODELVIEW + 12 + column] = t;
            }
            c[CONST_INVERSE_MODELVIEW + 15] = 1.0;

            c[CONST_MODELSCALE] = 0.05;

            this.params[PARAMS_EXPOSURE] = this.exposure;
            constantBuffer.write(offset, Ref(c[0]), CONST_FLOATS * 4);
            constantBuffer.write(offset + MATRICES_VIEW_SIZE, Ref(this.params[0]), PARAMS_FLOATS * 4);
        }

        // Clears the filter target once: the composition reads it from the first frame, also while
        // bloom is off, and D3D12 rejects reading a render target (not zeroed at creation) before a
        // clear.
        initializeTargets(commandBuffer: NriCommandBuffer) {
            const filterColor = this.filterColor;
            if (!filterColor) {
                return;
            }
            commandBuffer.textureBarrier(filterColor.texture, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            commandBuffer.beginRendering(filterColor.attachment);
            commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
            commandBuffer.endRendering();
            commandBuffer.textureBarrier(filterColor.texture, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
            this.targetsInitialized = true;
        }

        // A model with a pipeline (between NriCommandBuffer.beginRenderingWithTwoColorsAndDepth and
        // NriCommandBuffer.endRendering).
        drawModel(commandBuffer: NriCommandBuffer, pipeline: NriPipeline | null, mesh: NriGltfMesh | null) {
            if (!pipeline || !mesh) {
                return;
            }
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setIndexBuffer(mesh.getIndexBuffer(), 0, NriIndexType.UInt32);
            commandBuffer.setVertexBuffer(0, mesh.getVertexBuffer(), 0, VERTEX_SIZE);
            commandBuffer.drawIndexed(mesh.getIndexCount(), 1, 0, 0, 0);
        }

        // A fullscreen triangle of the pipeline with a fullscreen passes' set (between
        // NriCommandBuffer.beginRendering and NriCommandBuffer.endRendering).
        drawFullscreen(commandBuffer: NriCommandBuffer, pipeline: NriPipeline | null, set: NriDescriptorSet | null) {
            const postLayout = this.postLayout;
            if (!postLayout || !pipeline || !set) {
                return;
            }
            commandBuffer.setPipelineLayout(postLayout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setDescriptorSet(0, set);
            commandBuffer.draw(3, 1, 0, 0);
        }

        // First pass: the scene into the offscreen targets, cleared (reversed depth: the far plane
        // is 0); the skybox (when shown) and the object.
        recordScene(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const offscreenColor0 = this.offscreenColor0;
            const offscreenColor1 = this.offscreenColor1;
            const depthAttachment = this.depthAttachment;
            const modelsLayout = this.modelsLayout;
            const modelsSet = queuedFrame.modelsSet;
            if (!offscreenColor0 || !offscreenColor1 || !depthAttachment || !modelsLayout || !modelsSet) {
                return;
            }
            commandBuffer.textureBarrier(offscreenColor0.texture, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            commandBuffer.textureBarrier(offscreenColor1.texture, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            commandBuffer.beginRenderingWithTwoColorsAndDepth(offscreenColor0.attachment, offscreenColor1.attachment, depthAttachment);
            commandBuffer.clearColorAttachment(0, 0.0, 0.0, 0.0, 0.0);
            commandBuffer.clearColorAttachment(1, 0.0, 0.0, 0.0, 0.0);
            commandBuffer.clearDepth(0.0);
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(modelsLayout);
            commandBuffer.setDescriptorSet(0, modelsSet);
            if (this.displaySkybox) {
                this.drawModel(commandBuffer, this.skyboxPipeline, this.skybox);
            }
            this.drawModel(commandBuffer, this.reflectPipeline, this.objects[this.objectIndex]);
            commandBuffer.endRendering();
            commandBuffer.textureBarrier(offscreenColor0.texture, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
            commandBuffer.textureBarrier(offscreenColor1.texture, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
        }

        // Second pass: the first bloom pass, the bright parts blurred into the filter target.
        recordBloomFilter(commandBuffer: NriCommandBuffer) {
            const filterColor = this.filterColor;
            if (!filterColor) {
                return;
            }
            commandBuffer.textureBarrier(filterColor.texture, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            commandBuffer.beginRendering(filterColor.attachment);
            commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            this.drawFullscreen(commandBuffer, this.bloomFilterPipeline, this.bloomFilterSet);
            commandBuffer.endRendering();
            commandBuffer.textureBarrier(filterColor.texture, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.animate();

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                this.recordAndPresent(frameIndex, queuedFrame, queuedFrameIndex, index);
            }

            // Signaled after the present, as NRISamples do
            this.frames.signal(frameIndex);
        }

        // Records the frame into the swap chain texture, submits it and presents it.
        recordAndPresent(frameIndex: int, queuedFrame: QueuedFrame, queuedFrameIndex: int, index: int) {
            const descriptorPool = this.descriptorPool;
            const constantBuffer = this.constantBuffer;
            if (!descriptorPool || !constantBuffer) {
                return;
            }
            const commandBuffer = queuedFrame.commandBuffer;
            this.updateConstants(constantBuffer, queuedFrameIndex * CONST_STRIDE);

            commandBuffer.begin();
            if (this.imgui) {
                this.sample.copyImguiData(commandBuffer);
            }
            commandBuffer.setDescriptorPool(descriptorPool);
            if (!this.targetsInitialized) {
                this.initializeTargets(commandBuffer);
            }

            this.recordScene(commandBuffer, queuedFrame);
            if (this.bloom) {
                this.recordBloomFilter(commandBuffer);
            }

            // Third pass: the scene with the second bloom pass (when enabled) added, into the swap
            // chain texture; the overlay over them.
            commandBuffer.textureBarrier(this.swapChain.texture(index), NriTextureState.Undefined, NriTextureState.ColorAttachment);
            commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            this.drawFullscreen(commandBuffer, this.compositionPipeline, this.compositionSet);
            if (this.bloom) {
                this.drawFullscreen(commandBuffer, this.bloomCompositePipeline, this.compositionSet);
            }
            if (this.imgui) {
                this.sample.drawImgui(commandBuffer, this.viewFormat);
            }
            commandBuffer.endRendering();

            // The test's last frame: read back
            let presentFrom = NriTextureState.ColorAttachment;
            const readbackBuffer = this.readbackBuffer;
            if (readbackBuffer) {
                if (frameIndex == TEST_FRAMES - 1) {
                    commandBuffer.textureBarrier(this.swapChain.texture(index), NriTextureState.ColorAttachment, NriTextureState.CopySource);
                    commandBuffer.readbackTextureToBuffer(readbackBuffer, this.rowPitch, this.swapChain.texture(index), this.width, this.height);
                    presentFrom = NriTextureState.CopySource;
                }
            }
            commandBuffer.textureBarrier(this.swapChain.texture(index), presentFrom, NriTextureState.Present);
            commandBuffer.end();

            // Submit and present
            this.swapChain.submit(commandBuffer, index);
            if (this.imgui) {
                this.sample.imguiEndFrame();
            }
            this.swapChain.present(index);
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
                    this.destroyDescriptor(queuedFrame.matricesView);
                    this.destroyDescriptor(queuedFrame.paramsView);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                this.destroySizeTargets();
                this.destroyDescriptor(this.envmapView);
                this.destroyDescriptor(this.anisotropicSampler);
                this.destroyDescriptor(this.pointSampler);
                this.destroyTexture(this.envmap);
                const skybox = this.skybox;
                if (skybox) {
                    skybox.destroy();
                }
                for (const object of this.objects) {
                    object.destroy();
                }
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.skyboxPipeline);
                this.destroyPipeline(this.reflectPipeline);
                this.destroyPipeline(this.bloomFilterPipeline);
                this.destroyPipeline(this.compositionPipeline);
                this.destroyPipeline(this.bloomCompositePipeline);
                this.destroyPipelineLayout(this.modelsLayout);
                this.destroyPipelineLayout(this.postLayout);
                this.frames.destroy();
                this.swapChain.destroy();
                device.destroy();
            }
            this.sample.destroy();
        }

        destroyTarget(target: Target | null) {
            if (!target) {
                return;
            }
            target.attachment.destroy();
            target.shaderResource.destroy();
            target.texture.destroy();
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

        destroyPipelineLayout(pipelineLayout: NriPipelineLayout | null) {
            if (pipelineLayout) {
                pipelineLayout.destroy();
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        const hdr = new Hdr(sample);
        // -object <0..2>, -exposure <value>, -nobloom, -noskybox: the settings' initial values;
        // -noUI: no overlay.
        sample.addExampleOptionWithValues("-object", 1);
        sample.addExampleOptionWithValues("-exposure", 1);
        sample.addExampleOption("-nobloom");
        sample.addExampleOption("-noskybox");
        sample.addExampleOption("-noUI");
        sample.useImgui();
        sample.useResizableWindow();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-nobloom") {
                hdr.bloom = false;
            } else if (arg == "-noskybox") {
                hdr.displaySkybox = false;
            } else if (arg == "-object" && i + 1 < argc) {
                i++;
                hdr.objectIndex = Math.min(Math.max(parseInt(Nri.getArg(argc, argv, i)), 0), 2);
            } else if (arg == "-exposure" && i + 1 < argc) {
                i++;
                hdr.exposure = parseFloat(Nri.getArg(argc, argv, i));
            } else if (arg == "-noUI") {
                hdr.noUI = true;
            }
        }
        return hdr.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return HdrNri.main(argc, argv);
}

/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { radians, perspProjD3DStyleReverse } from "../../core/matrix";
import { randomFloat } from "../../core/random";
import { DonutThirdPersonCamera } from "../../core/donut_third_person_camera";
import { DonutSceneTextures } from "../../core/nri_donut_textures";
import { DonutBlit } from "../../core/nri_donut_blit";
import { Nri, NriAccelerationStructure, NriBlasDesc, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriDonutScene, NriDonutSceneAccelStructs, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture, NriTopLevelAS, NriUpdatableBlas } from "../../core/nri";

namespace RtParticlesNri {
    // rt_particles, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut and
    // NVRHI: the same compute shader (rt_particles.hlsl, as Donut compiles it), the scene loaded as Donut's
    // engine loads it (core/nri/nri_donut_scene.cpp) with the particle mesh added as Donut attaches it, its
    // acceleration structures as Donut builds them, Donut's blit shaders, through the NRI calls
    // core/nri/nri_interop.d.ts binds. This example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no ray queries, or no shaders for the
    // graphics API (D3D11).
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Ray Traced Particles";
    const SCENE_PATH = "media/rt_particles/ParticleScene.gltf";
    const ENVIRONMENT_MAP_PATH = "media/rt_particles/environment-map.dds";
    // The particle textures (sRGB), in ParticleTexture order.
    const PARTICLE_TEXTURE_PATHS = ["media/rt_particles/smoke-particle.png", "media/nvidia-logo.png"];

    const MAX_PARTICLES = 1024;
    const INDICES_PER_QUAD = 6;
    const VERTICES_PER_QUAD = 4;
    const MAX_VERTICES = MAX_PARTICLES * VERTICES_PER_QUAD;
    const MAX_INDICES = MAX_PARTICLES * INDICES_PER_QUAD;
    // The particle mesh's vertex buffer: MAX_VERTICES float3 positions, then MAX_VERTICES float2 texture
    // coordinates (Donut_CreateDynamicMesh's buffer group).
    const TEXCOORD_OFFSET = MAX_VERTICES * 12;
    const VERTEX_BUFFER_SIZE = MAX_VERTICES * 20;

    // main in rt_particles.hlsl runs 16 x 16 threads per group.
    const COMPUTE_GROUP_SIZE = 16;
    // The MLAB_FRAGMENTS permutations compiled in shaders/rt_particles.cfg.
    const g_MlabFragmentCounts: int[] = [1, 2, 4, 8];

    // From shaders/rt_particles_cb.h.
    const INSTANCE_MASK_OPAQUE = 1;
    const INSTANCE_MASK_PARTICLE_GEOMETRY = 2;
    const INSTANCE_MASK_INTERSECTION_PARTICLE = 4;

    // The bindless buffer array: the scene's vertices and indices (the numbers its GeometryData have),
    // then the particle mesh's.
    const BINDLESS_SCENE_VERTICES = 0;
    const BINDLESS_SCENE_INDICES = 1;
    const BINDLESS_PARTICLE_VERTICES = 2;
    const BINDLESS_PARTICLE_INDICES = 3;
    const BINDLESS_BUFFER_COUNT = 4;

    // NriDevice.createDonutSceneBuffer's buffers: vertices, indices, InstanceData, GeometryData, MaterialConstants.
    const SCENE_BUFFER_COUNT = 5;
    const SCENE_BUFFER_MATERIALS = 4;

    // NriAccelerationStructureFlags.PreferFastTrace: Donut's particle mesh BLAS (GetMeshBlasDesc's).
    const PREFER_FAST_TRACE = 32;

    enum OrientationMode {
        AvtMatrix = 0,
        Quaternion = 1,
        Beam = 2,
        Basis = 3
    }

    // struct ParticleInfo (64 bytes), as f32 offsets.
    const PARTICLE_INFO_FLOATS = 16;
    const PARTICLE_INFO_CENTER = 0;
    const PARTICLE_INFO_ROTATION = 3;
    const PARTICLE_INFO_X_AXIS = 4;
    const PARTICLE_INFO_INVERSE_RADIUS = 7;
    const PARTICLE_INFO_Y_AXIS = 8;
    const PARTICLE_INFO_TEXTURE_INDEX = 11; // int
    const PARTICLE_INFO_COLOR_FACTOR = 12;
    const PARTICLE_INFO_OPACITY_FACTOR = 15;

    // struct GlobalConstants: PlanarViewConstants view, then these, as f32 offsets from the end of `view`.
    const GLOBAL_PRIMARY_RAY_CONE_ANGLE = 0;
    const GLOBAL_REORIENT_PRIMARY = 1;   // uint
    const GLOBAL_REORIENT_SECONDARY = 2; // uint
    const GLOBAL_ORIENTATION_MODE = 3;   // uint
    const GLOBAL_ENVIRONMENT_MAP = 4;    // int
    const GLOBAL_TAIL_FLOATS = 5;

    enum ParticleTexture {
        Smoke = 0,
        Logo = 1
    }

    // Constant buffer views' alignment.
    const CONSTANTS_ALIGNMENT = 256;

    // Donut's blit (CommonRenderPasses::BlitTexture) of a level into the next: struct BlitConstants
    // { float2 sourceOrigin, sourceSize, targetOrigin, targetSize; float sharpenFactor; }.
    const MIP_BLIT_CONSTANTS: f32[] = [0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0];

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // -test: checks the last frame, read back, as the Donut example does: the reflective scene fills it,
    // the particles' colored puffs about 0.6% of it.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const total = width * height;
        let dark = 0;
        let colored = 0;
        for (let i = 0; i < total; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r <= 20 && g <= 20 && b <= 20) {
                dark++;
            }
            let high = r;
            let low = r;
            if (g > high) {
                high = g;
            }
            if (b > high) {
                high = b;
            }
            if (g < low) {
                low = g;
            }
            if (b < low) {
                low = b;
            }
            if (high - low >= 61) {
                colored++;
            }
        }
        const lit = 100.0 * (total - dark) / total;
        console.log(`Lit: ${lit}% (${total - dark} of ${total} pixels)`);
        if (lit < 95.0 || lit > 100.0) {
            return `Lit: ${lit}% of the pixels, not 95% to 100%`;
        }
        const particles = 100.0 * colored / total;
        console.log(`Particles: ${particles}% (${colored} of ${total} pixels)`);
        if (particles < 0.2 || particles > 2.0) {
            return `Particles: ${particles}% of the pixels, not 0.2% to 2%`;
        }
        return "";
    }

    function saturate(x: number) {
        return Math.min(Math.max(x, 0.0), 1.0);
    }

    function align(size: int) {
        return Math.floor((size + CONSTANTS_ALIGNMENT - 1) / CONSTANTS_ALIGNMENT) * CONSTANTS_ALIGNMENT;
    }

    // An f32 array of n zeros.
    function zeros(n: int) {
        const values: f32[] = [];
        for (let i = 0; i < n; i++) {
            values.push(0.0);
        }
        return values;
    }

    // --- Particles ----------------------------------------------------------------------------

    class ParticleEntity {
        public active: boolean;
        public positionX: number;
        public positionY: number;
        public positionZ: number;
        public velocityX: number;
        public velocityY: number;
        public velocityZ: number;
        public colorR: number;
        public colorG: number;
        public colorB: number;
        public radius: number;
        public age: number;
        public opacity: number;
        public rotation: number;

        constructor() {
            this.active = false;
            this.positionX = 0.0;
            this.positionY = 0.0;
            this.positionZ = 0.0;
            this.velocityX = 0.0;
            this.velocityY = 0.0;
            this.velocityZ = 0.0;
            this.colorR = 1.0;
            this.colorG = 1.0;
            this.colorB = 1.0;
            this.radius = 0.0;
            this.age = 0.0;
            this.opacity = 1.0;
            this.rotation = 0.0;
        }

        emit(emitterX: number, emitterY: number, emitterZ: number) {
            this.active = true;
            this.positionX = emitterX;
            this.positionY = emitterY;
            this.positionZ = emitterZ;
            this.velocityX = randomFloat() - 0.5;
            this.velocityY = 1.0 + randomFloat() - 0.5;
            this.velocityZ = randomFloat() - 0.5;
            this.radius = randomFloat() * 0.05 + 0.1;
            this.age = 0.0;
            this.opacity = 1.0;
            this.colorR = randomFloat() * 0.5 + 0.1;
            this.colorG = randomFloat() * 0.5 + 0.1;
            this.colorB = randomFloat() * 0.5 + 0.1;
            this.rotation = randomFloat() * 6.28;
        }

        animate(time: number) {
            const lifeTime = 2.0;

            this.positionX += this.velocityX * time;
            this.positionY += this.velocityY * time;
            this.positionZ += this.velocityZ * time;
            this.velocityY += 1.0 * time;
            this.velocityX += 1.0 * time;
            this.age += time;
            this.radius += 0.5 * time;
            this.opacity = saturate((lifeTime - this.age) * 0.5);

            if (this.age > lifeTime) {
                this.active = false;
            }
        }
    }

    // --- Resources ----------------------------------------------------------------------------

    // What a frame in flight records into, its sets and its copies of what the CPU writes every frame:
    // the constants' view, the particle mesh's buffers and the ParticleInfo buffer (with their views).
    class QueuedFrame {
        constructor(public commandBuffer: NriCommandBuffer,
            public set: NriDescriptorSet, public bindlessSet: NriDescriptorSet, public constantView: NriDescriptor,
            public vertexBuffer: NriBuffer, public vertexView: NriDescriptor, public indexBuffer: NriBuffer,
            public indexView: NriDescriptor, public particleInfoBuffer: NriBuffer,
            public particleInfoView: NriDescriptor) {
        }
    }

    // A blit of a texture's level into the next (the mip chains Donut's TextureCache generates for files
    // without mips): the level's attachment view, the set of the level above's view.
    class MipBlit {
        constructor(public texture: NriTexture, public mip: int, public width: int, public height: int,
            public attachment: NriDescriptor, public sourceView: NriDescriptor, public set: NriDescriptorSet) {
        }
    }

    // The particle textures (sRGB PNG files) as Donut_LoadBindlessTexture loads them: each with the mip
    // chain below its first level blitted level by level with Donut's blit shaders through sRGB views.
    class ParticleTextures {
        textures: NriTexture[] = [];
        views: NriDescriptor[] = [];
        private blits: MipBlit[] = [];
        private blitted: boolean = false;
        private blitLayout: NriPipelineLayout | null = null;
        private blitPipeline: NriPipeline | null = null;
        private linearClamp: NriDescriptor | null = null;
        private blitConstants: f32[] = [];

        load(device: NriDevice, queue: NriQueue, folder: string): boolean {
            for (const value of MIP_BLIT_CONSTANTS) {
                this.blitConstants.push(value);
            }
            for (const path of PARTICLE_TEXTURE_PATHS) {
                const texture = device.loadImageTextureWithMipChain(queue, path, 1);
                if (!texture) {
                    console.log(`Cannot load the texture ${path}`);
                    return false;
                }
                this.textures.push(texture);
                this.views.push(texture.createView(NriFormat.RGBA8_SRGB));
            }

            // Donut's blit: its constants (b0), the source (t0), linear clamp sampling (s0).
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRootConstants(0, MIP_BLIT_CONSTANTS.length * 4, NriStage.Vertex);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            const layout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
            this.blitLayout = layout;
            if (!layout) {
                console.log("Cannot create the blit's layout");
                return false;
            }
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `shaders/framework/${folder}/rect_vs.bin`, "main") != 0;
            if (loaded) {
                loaded = desc.addShaderPermutation(NriShaderStage.Pixel, `shaders/framework/${folder}/blit_ps.bin`, "main",
                    "TEXTURE_ARRAY=0") != 0;
            }
            desc.setTopology(NriTopology.TriangleStrip);
            desc.setColor(NriFormat.RGBA8_SRGB, NriColorWrite.RGBA);
            this.blitPipeline = loaded ? device.createPipelineFromDesc(layout, desc) : null;
            desc.destroy();
            if (!this.blitPipeline) {
                console.log("Cannot load Donut's blit shaders");
                return false;
            }
            this.linearClamp = device.createSampler(NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
            return true;
        }

        // The sets the mip chains' blits take from a pool (a texture and a sampler each).
        blitSetCount(): int {
            let count = 0;
            for (const texture of this.textures) {
                count += texture.getMipNum() - 1;
            }
            return count;
        }

        createBlits(descriptorPool: NriDescriptorPool): boolean {
            const layout = this.blitLayout;
            const linearClamp = this.linearClamp;
            if (!layout || !linearClamp) {
                return false;
            }
            for (const texture of this.textures) {
                const mipNum = texture.getMipNum();
                const width = texture.getWidth();
                const height = texture.getHeight();
                for (let mip = 1; mip < mipNum; mip++) {
                    const set = descriptorPool.allocateDescriptorSet(layout, 0, 0);
                    if (!set) {
                        return false;
                    }
                    const sourceView = texture.createMipView(NriFormat.RGBA8_SRGB, mip - 1);
                    set.updateDescriptor(0, 0, sourceView);
                    set.updateDescriptor(1, 0, linearClamp);
                    this.blits.push(new MipBlit(new NriTexture(texture.handle), mip, Math.max(width >> mip, 1), Math.max(height >> mip, 1),
                        texture.createColorAttachmentMipView(NriFormat.RGBA8_SRGB, mip), sourceView, set));
                }
            }
            return true;
        }

        // The mip chains, once (the first frame, before the textures are read; the pool set).
        recordBlits(commandBuffer: NriCommandBuffer) {
            const layout = this.blitLayout;
            const pipeline = this.blitPipeline;
            if (this.blitted || !layout || !pipeline) {
                return;
            }
            for (const blit of this.blits) {
                commandBuffer.textureMipBarrier(blit.texture, blit.mip, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
                commandBuffer.beginRendering(blit.attachment);
                commandBuffer.setViewport(0.0, 0.0, blit.width, blit.height);
                commandBuffer.setScissor(0, 0, blit.width, blit.height);
                commandBuffer.setPipelineLayout(layout);
                commandBuffer.setPipeline(pipeline);
                commandBuffer.setRootConstants(0, Ref(this.blitConstants[0]), MIP_BLIT_CONSTANTS.length * 4);
                commandBuffer.setDescriptorSet(0, blit.set);
                commandBuffer.draw(4, 1, 0, 0);
                commandBuffer.endRendering();
                commandBuffer.textureMipBarrier(blit.texture, blit.mip, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
            }
            this.blitted = true;
        }

        // After the device is idle (the sets go with their pool).
        destroy() {
            for (const blit of this.blits) {
                blit.attachment.destroy();
                blit.sourceView.destroy();
            }
            for (const view of this.views) {
                view.destroy();
            }
            for (const texture of this.textures) {
                texture.destroy();
            }
            const pipeline = this.blitPipeline;
            if (pipeline) {
                pipeline.destroy();
            }
            const layout = this.blitLayout;
            if (layout) {
                layout.destroy();
            }
            const linearClamp = this.linearClamp;
            if (linearClamp) {
                linearClamp.destroy();
            }
        }
    }

    // --- The example --------------------------------------------------------------------------

    // Port of Donut-Samples' rt_particles.cpp (as examples/rt_particles.ts ports it) to NRI: a compute
    // shader traces ray queries through a scene with particles in it twice over, as camera-facing
    // billboard triangles (a dynamic mesh rebuilt every frame) and as procedural AABB instances
    // intersected in the shader, and blends them with multi-layer alpha blending (MLAB, 1-8 fragments),
    // including in reflections; the result is blitted into the swap chain, the settings window drawn
    // over it. The left mouse button orbits the camera (Donut's ThirdPersonCamera), the wheel zooms,
    // Space pauses the particles.
    class RtParticles {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        // The swap chain's size: the window's when it was (re)created.
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views'.
        private swapChainFormat: NriFormat = 0;
        private swapChainViewFormat: NriFormat = 0;
        private test: boolean = false;
        private imgui: boolean = false;
        private folder: string = "dxil";
        private vulkan: boolean = false;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        // The settings the UI edits (the sample's UIData).
        updatePipeline: boolean = true;
        enableAnimations: boolean = true;
        alwaysUpdateOrientation: boolean = true;
        reorientParticlesInPrimaryRays: boolean = false;
        reorientParticlesInSecondaryRays: boolean = true;
        orientationMode: int = OrientationMode.Quaternion;
        mlabFragments: int = 4;
        particleTexture: int = ParticleTexture.Smoke;
        emitterPosition: f32[] = zeros(3);
        // -noUI: no settings window (the Donut example adds no ImGui pass then).
        noUI: boolean = false;

        // The scene with the particle mesh: its buffers (NriDevice.createDonutSceneBuffer's) and their views,
        // its textures (the bindless array's first), its BLASes; the particle mesh's instance and
        // material; the unit AABB's BLAS; the TLAS built every frame.
        private scene: NriDonutScene | null = null;
        private sceneBuffers: NriBuffer[] = [];
        private sceneBufferViews: NriDescriptor[] = [];
        private sceneTextures: DonutSceneTextures = new DonutSceneTextures();
        private accelStructs: NriDonutSceneAccelStructs | null = null;
        private sceneInstanceCount: int = 0;
        private sceneBlases: NriAccelerationStructure[] = [];
        // Each scene instance's transform, 12 floats.
        private sceneTransforms: f32[] = [];
        private particleInstance: int = 0;
        private particleMaterial: int = 0;
        private particleBlas: NriUpdatableBlas | null = null;
        private intersectionBlas: NriAccelerationStructure | null = null;
        private topLevelAS: NriTopLevelAS | null = null;
        private topLevelASView: NriDescriptor | null = null;
        private identity: f32[] = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        private particleTransform: f32[] = zeros(12);

        // The environment map and the particle textures, after the scene's in the bindless texture array.
        private environmentMap: NriTexture | null = null;
        private environmentMapView: NriDescriptor | null = null;
        private particleTextures: ParticleTextures = new ParticleTextures();
        private textureViews: NriDescriptor[] = [];
        private environmentMapIndex: int = 0;
        private particleTextureIndices: int[] = [];
        // The particle texture last given to the particle mesh's material, and whether the scene has yet
        // to see it.
        private appliedParticleTexture: int = -1;
        private materialDirty: boolean = false;

        // The compute pass: its layout, its pipeline ((re)created when updatePipeline is set), the color
        // buffer it writes (RGBA16F; the state it's in between frames), the sampler, the blit.
        private layout: NriPipelineLayout | null = null;
        private pipeline: NriPipeline | null = null;
        private textureSet: NriDescriptorSet | null = null;
        private colorBuffer: NriTexture | null = null;
        private colorStorage: NriDescriptor | null = null;
        private colorView: NriDescriptor | null = null;
        private colorState: NriTextureState = NriTextureState.Storage;
        private anisotropicWrap: NriDescriptor | null = null;
        private blit: DonutBlit = new DonutBlit();
        private blitSet: NriDescriptorSet | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private constantBuffer: NriBuffer | null = null;
        private constantStride: int = 0;
        // The queued frame whose particle mesh buffers and ParticleInfo hold the particles the
        // acceleration structures were last built of (-1: none yet).
        private geometrySlot: int = -1;

        private particles: ParticleEntity[] = [];
        private wallclockTime: number = 0.0;
        private lastEmitTime: number = 0.0;

        // Per-frame particle geometry and ParticleInfo data (the indices as 32-bit words).
        private indices: f32[] = zeros(MAX_INDICES);
        private positions: f32[] = zeros(MAX_VERTICES * 3);
        private texCoords: f32[] = zeros(MAX_VERTICES * 2);
        private particleInfos: f32[] = zeros(MAX_PARTICLES * PARTICLE_INFO_FLOATS);

        private camera: DonutThirdPersonCamera = new DonutThirdPersonCamera();
        // The GlobalConstants contents; the fields after `view` start at viewFloats.
        private constants: f32[] = [];
        private viewFloats: int = 0;
        private constantsSize: int = 0;
        private viewMatrix: f32[] = zeros(16);
        private projMatrix: f32[] = zeros(16);

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
            for (let i = 0; i < MAX_PARTICLES; i++) {
                this.particles.push(new ParticleEntity());
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

            // Swap chain: blitted into through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            this.viewFormat = this.swapChainViewFormat;

            // Ray queries: D3D12 or Vulkan (the Donut example's shaders have no DXBC).
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "No D3D11 shaders (ray queries need D3D12 or Vulkan)";
                return 0;
            }
            if (device.isFeatureSupported(NriFeature.RayQuery) == 0) {
                this.unsupportedReason = "The graphics device does not support Ray Queries";
                return 0;
            }
            this.vulkan = graphicsAPI == NriGraphicsAPI.VK;
            this.folder = this.vulkan ? "spirv" : "dxil";

            if (!this.loadTextures(device) || !this.loadScene(device, queuedFrameNum) || !this.createTargets(device)
                || !this.createLayout(device) || !this.blit.init(device, this.folder, this.viewFormat)
                || !this.createDescriptorSets(device, queuedFrameNum)) {
                return 0;
            }

            if (!this.noUI) {
                if (this.sample.initImgui(device) == 0) {
                    console.log("Cannot initialize the user interface");
                    return 0;
                }
                this.imgui = true;
            }

            // The sample's camera: orbiting 2 above the emitter, 6 away.
            this.camera.setTarget(this.emitterPosition[0], this.emitterPosition[1] + 2.0, this.emitterPosition[2]);
            this.camera.setDistance(6.0);
            this.camera.setRotation(radians(225.0), radians(20.0));

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The environment map and the particle textures (Donut_LoadBindlessTexture's).
        loadTextures(device: NriDevice) {
            const environmentMap = device.loadDdsTexture(this.queue, ENVIRONMENT_MAP_PATH, 0);
            this.environmentMap = environmentMap;
            if (!environmentMap) {
                console.log("Cannot load the particle textures");
                return false;
            }
            this.environmentMapView = environmentMap.createView(environmentMap.getFormat());
            if (!this.particleTextures.load(device, this.queue, this.folder)) {
                console.log("Cannot load the particle textures");
                return false;
            }
            return true;
        }

        // The scene as Donut's engine loads it, its BLASes, then the particle mesh attached to it (an
        // instance and material after the scene's, its buffers bindless buffers 2 and 3), the scene's
        // buffers (with the particle mesh's InstanceData, GeometryData and MaterialConstants), its
        // textures; the particle mesh's BLAS, the unit AABB's, the TLAS.
        loadScene(device: NriDevice, queuedFrameNum: int) {
            const scene = NriDonutScene.load(SCENE_PATH);
            this.scene = scene;
            if (!scene) {
                console.log(`Cannot load the scene ${SCENE_PATH}`);
                return false;
            }
            if (Nri.getDonutSceneNodePosition(SCENE_PATH, "/Emitter", Ref(this.emitterPosition[0])) == 0) {
                console.log("The scene has no emitter node");
            }

            // Donut_BuildSceneBLASes: the scene's meshes' (the particle mesh has its own).
            const accelStructs = device.buildDonutSceneAccelStructs(this.queue, scene);
            this.accelStructs = accelStructs;
            if (!accelStructs) {
                console.log("Cannot build the scene's acceleration structures");
                return false;
            }
            this.sceneInstanceCount = scene.getInstanceCount();
            for (let i = 0; i < this.sceneInstanceCount; i++) {
                const blas = scene.getInstanceBlas(accelStructs, i);
                if (!blas) {
                    console.log("Cannot build the scene's acceleration structures");
                    return false;
                }
                this.sceneBlases.push(blas);
                for (let k = 0; k < 12; k++) {
                    this.sceneTransforms.push(0.0);
                }
                scene.getInstanceTransform(i, Ref(this.sceneTransforms[i * 12]));
            }

            this.particleInstance = scene.addDynamicMesh(MAX_VERTICES, MAX_INDICES, BINDLESS_PARTICLE_VERTICES,
                BINDLESS_PARTICLE_INDICES);
            this.particleMaterial = scene.getGeometryMaterial(this.particleInstance, 0);

            // The bindless textures: the scene's (its materials' numbers), the environment map, the particle
            // textures.
            if (!this.sceneTextures.load(device, this.queue, scene, this.folder)) {
                return false;
            }
            // Wrappers of their own (destroying nothing): the views stay sceneTextures' and particleTextures'.
            for (const view of this.sceneTextures.views) {
                this.textureViews.push(new NriDescriptor(view.handle));
            }
            const environmentMapView = this.environmentMapView;
            if (!environmentMapView) {
                return false;
            }
            this.environmentMapIndex = this.textureViews.length;
            this.textureViews.push(new NriDescriptor(environmentMapView.handle));
            for (const view of this.particleTextures.views) {
                this.particleTextureIndices.push(this.textureViews.length);
                this.textureViews.push(new NriDescriptor(view.handle));
            }

            // Its texture set before the scene's buffers are made (Donut's first onRender, before the
            // first refreshScene).
            this.applyParticleTexture();
            for (let which = 0; which < SCENE_BUFFER_COUNT; which++) {
                const buffer = device.createDonutSceneBuffer(this.queue, scene, which);
                if (!buffer) {
                    console.log("Cannot create the scene's buffers");
                    return false;
                }
                this.sceneBuffers.push(buffer);
                const view = buffer.createStructuredView(0);
                if (!view) {
                    console.log("Cannot create the scene's buffers");
                    return false;
                }
                this.sceneBufferViews.push(view);
            }

            // Donut_CreateDynamicMesh's BLAS (GetMeshBlasDesc's: non-opaque, its material being alpha-blended;
            // prefer fast trace), the unit AABB's (Donut_CreateUnitAABBBlas'), the TLAS (the scene's
            // instances, the particle mesh's included, plus one per particle).
            this.particleBlas = device.createDynamicTriangleBlas(MAX_VERTICES, 12, MAX_INDICES, PREFER_FAST_TRACE, 0);
            const desc = NriBlasDesc.create();
            const aabb: f32[] = [-1.0, -1.0, -1.0, 1.0, 1.0, 1.0];
            desc.addAabbs(Ref(aabb[0]), 1);
            this.intersectionBlas = device.buildBlasFromDesc(this.queue, desc, NriAccelerationStructureFlags.None);
            desc.destroy();
            const topLevelAS = device.createTopLevelAS(scene.getInstanceCount() + MAX_PARTICLES,
                NriAccelerationStructureFlags.None, queuedFrameNum);
            this.topLevelAS = topLevelAS;
            if (!this.particleBlas || !this.intersectionBlas || !topLevelAS) {
                console.log("Cannot create the particles' acceleration structures");
                return false;
            }
            this.topLevelASView = topLevelAS.getTopLevelAccelerationStructure().createDescriptor();
            if (!this.topLevelASView) {
                console.log("Cannot create the particles' acceleration structures");
                return false;
            }
            return true;
        }

        // The particle mesh's material's texture (Donut_SetDynamicMeshTexture): the particle texture chosen.
        applyParticleTexture() {
            const scene = this.scene;
            if (!scene) {
                return;
            }
            scene.setMaterialBaseTexture(this.particleMaterial, this.particleTextureIndices[this.particleTexture]);
            this.appliedParticleTexture = this.particleTexture;
            this.materialDirty = true;
        }

        // The color buffer the compute shader writes (createUAVTextureForFrameWithFormat's RGBA16F).
        createTargets(device: NriDevice) {
            const colorBuffer = device.createStorageTexture(this.queue, this.width, this.height, NriFormat.RGBA16_SFLOAT);
            this.colorBuffer = colorBuffer;
            if (!colorBuffer) {
                console.log("Cannot create the color buffer");
                return false;
            }
            this.colorStorage = colorBuffer.createStorageView(NriFormat.RGBA16_SFLOAT);
            this.colorView = colorBuffer.createView(NriFormat.RGBA16_SFLOAT);
            return true;
        }

        destroyTargets() {
            this.destroyDescriptor(this.colorStorage);
            this.destroyDescriptor(this.colorView);
            this.colorStorage = null;
            this.colorView = null;
            const colorBuffer = this.colorBuffer;
            if (colorBuffer) {
                colorBuffer.destroy();
            }
            this.colorBuffer = null;
        }

        // The sets reading or writing the color buffer: each queued frame's (its storage, 4/0) and the
        // blit's (its source, 0/0).
        updateTargetDescriptors() {
            const colorStorage = this.colorStorage;
            const colorView = this.colorView;
            if (!colorStorage || !colorView) {
                return;
            }
            for (const queuedFrame of this.queuedFrames) {
                queuedFrame.set.updateDescriptor(4, 0, colorStorage);
            }
            const blitSet = this.blitSet;
            if (blitSet) {
                blitSet.updateDescriptor(0, 0, colorView);
            }
        }

        // The compute shader's bindings: set 0 the constants (b0), the TLAS (t0), the InstanceData,
        // GeometryData, MaterialConstants and ParticleInfo (t1 to t4), the sampler (s0), the color buffer
        // (u0); the bindless arrays: on Vulkan set 1, the buffers at binding 0 and the textures at 1 (the
        // shader's vk::binding), on D3D12 spaces 1 and 2.
        createLayout(device: NriDevice) {
            const textureCount = this.textureViews.length;
            const arrayFlags = NriRangeFlags.PartiallyBound | NriRangeFlags.Array;
            const desc = NriPipelineLayoutDesc.create();
            desc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Compute, NriRangeFlags.None);
            desc.addRange(0, 0, 1, NriDescriptorType.AccelerationStructure, NriStage.Compute, NriRangeFlags.None);
            desc.addRange(0, 1, 4, NriDescriptorType.StructuredBuffer, NriStage.Compute, NriRangeFlags.None);
            desc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Compute, NriRangeFlags.None);
            desc.addRange(0, 0, 1, NriDescriptorType.StorageTexture, NriStage.Compute, NriRangeFlags.None);
            desc.addRange(1, 0, BINDLESS_BUFFER_COUNT, NriDescriptorType.StructuredBuffer, NriStage.Compute, arrayFlags);
            if (this.vulkan) {
                desc.addRange(1, 1, textureCount, NriDescriptorType.Texture, NriStage.Compute, arrayFlags);
            } else {
                desc.addRange(2, 0, textureCount, NriDescriptorType.Texture, NriStage.Compute, arrayFlags);
            }
            this.layout = device.createPipelineLayoutFromDesc(desc);
            desc.destroy();
            if (!this.layout) {
                console.log("Cannot create the pipeline layout");
                return false;
            }
            return true;
        }

        // The compute pipeline for mlabFragments (Donut's createShaderWithDefine of MLAB_FRAGMENTS); false on
        // failure. The old one, if any, after the device is idle.
        createComputePipeline(device: NriDevice) {
            const layout = this.layout;
            if (!layout) {
                return false;
            }
            const oldPipeline = this.pipeline;
            if (oldPipeline) {
                device.waitIdle();
                oldPipeline.destroy();
                this.pipeline = null;
            }
            this.pipeline = device.createComputePipelinePermutation(layout, `shaders/rt_particles/${this.folder}/rt_particles.bin`,
                "main", `MLAB_FRAGMENTS=${this.mlabFragments}`);
            if (!this.pipeline) {
                console.log("Cannot load the rt_particles shader");
                return false;
            }
            return true;
        }

        // The sampler, the constant buffer (a queued frame's GlobalConstants each), the queued frames
        // (their particle mesh and ParticleInfo buffers, their sets), the bindless texture set (D3D12),
        // the blits' sets.
        createDescriptorSets(device: NriDevice, queuedFrameNum: int) {
            const layout = this.layout;
            const topLevelASView = this.topLevelASView;
            const colorStorage = this.colorStorage;
            const colorView = this.colorView;
            if (!layout || !topLevelASView || !colorStorage || !colorView) {
                return false;
            }
            const anisotropicWrap = device.createSampler(NriFilter.Linear, NriAddressMode.Repeat, 16);
            this.anisotropicWrap = anisotropicWrap;

            this.viewFloats = Nri.getDonutConstantsSize(0) / 4;
            this.constantsSize = (this.viewFloats + GLOBAL_TAIL_FLOATS) * 4;
            this.constants = zeros(this.viewFloats + GLOBAL_TAIL_FLOATS);
            this.constantStride = align(this.constantsSize);
            const constantBuffer = device.createHostBuffer(queuedFrameNum * this.constantStride, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;

            const textureCount = this.textureViews.length;
            const blitCount = this.sceneTextures.blitSetCount() + this.particleTextures.blitSetCount();
            const descriptorPool = device.createDescriptorPoolWithAccelerationStructures(
                2 * queuedFrameNum + 2 + blitCount,
                queuedFrameNum + 1 + blitCount,
                queuedFrameNum,
                (queuedFrameNum + 1) * textureCount + 1 + blitCount,
                queuedFrameNum,
                (4 + BINDLESS_BUFFER_COUNT) * queuedFrameNum,
                queuedFrameNum);
            this.descriptorPool = descriptorPool;
            if (!constantBuffer || !descriptorPool || !anisotropicWrap) {
                console.log("Cannot create the descriptors");
                return false;
            }

            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const set = descriptorPool.allocateDescriptorSet(layout, 0, 0);
                const bindlessSet = descriptorPool.allocateDescriptorSet(layout, 1, 0);
                const constantView = constantBuffer.createConstantView(i * this.constantStride, this.constantStride);
                // The particle mesh's buffers (raw, read by the shader and the BLAS build) and the
                // ParticleInfo structures, written by the CPU every frame.
                const vertexBuffer = device.createHostBufferWithStride(VERTEX_BUFFER_SIZE, NriBufferUsage.AccelerationStructureInput, 4);
                const indexBuffer = device.createHostBufferWithStride(MAX_INDICES * 4, NriBufferUsage.AccelerationStructureInput, 4);
                const particleInfoBuffer = device.createHostBufferWithStride(MAX_PARTICLES * PARTICLE_INFO_FLOATS * 4,
                    NriBufferUsage.StructuredBuffer, PARTICLE_INFO_FLOATS * 4);
                if (!set || !bindlessSet || !constantView || !vertexBuffer || !indexBuffer || !particleInfoBuffer) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                const vertexView = vertexBuffer.createStructuredView(0);
                const indexView = indexBuffer.createStructuredView(0);
                const particleInfoView = particleInfoBuffer.createStructuredView(0);
                if (!vertexView || !indexView || !particleInfoView) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                this.queuedFrames.push(new QueuedFrame(new NriCommandBuffer(this.frames.commandBuffer(i).handle), set, bindlessSet,
                    constantView, vertexBuffer, vertexView, indexBuffer, indexView, particleInfoBuffer, particleInfoView));

                set.updateDescriptor(0, 0, constantView);
                set.updateDescriptor(1, 0, topLevelASView);
                for (let k = 0; k < 3; k++) {
                    set.updateDescriptor(2, k, this.sceneBufferViews[2 + k]);
                }
                set.updateDescriptor(2, 3, particleInfoView);
                set.updateDescriptor(3, 0, anisotropicWrap);
                set.updateDescriptor(4, 0, colorStorage);
                bindlessSet.updateDescriptor(0, BINDLESS_SCENE_VERTICES, this.sceneBufferViews[0]);
                bindlessSet.updateDescriptor(0, BINDLESS_SCENE_INDICES, this.sceneBufferViews[1]);
                bindlessSet.updateDescriptor(0, BINDLESS_PARTICLE_VERTICES, vertexView);
                bindlessSet.updateDescriptor(0, BINDLESS_PARTICLE_INDICES, indexView);
                if (this.vulkan) {
                    for (let t = 0; t < textureCount; t++) {
                        bindlessSet.updateDescriptor(1, t, this.textureViews[t]);
                    }
                }
            }
            if (!this.vulkan) {
                const textureSet = descriptorPool.allocateDescriptorSet(layout, 2, 0);
                this.textureSet = textureSet;
                if (!textureSet) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                for (let t = 0; t < textureCount; t++) {
                    textureSet.updateDescriptor(0, t, this.textureViews[t]);
                }
            }

            this.blitSet = this.blit.createSet(descriptorPool, colorView);
            if (!this.blitSet || !this.sceneTextures.createBlits(descriptorPool) || !this.particleTextures.createBlits(descriptorPool)) {
                console.log("Cannot create the descriptor sets");
                return false;
            }
            return true;
        }

        // Waits for the frame that last used this frame's command allocator (and buffers).
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The settings window (the sample's UserInterface).
        buildUI() {
            this.sample.imguiNewFrame();
            NriImgui.setNextWindowPos(10.0, 10.0);
            NriImgui.begin("Settings", 1);

            this.enableAnimations = NriImgui.checkbox("Animate particles (Space)", this.enableAnimations ? 1 : 0) != 0;
            this.alwaysUpdateOrientation = NriImgui.checkbox("Update orientation when paused", this.alwaysUpdateOrientation ? 1 : 0) != 0;
            NriImgui.separator();

            NriImgui.text("Orientation mode:");
            NriImgui.indent();
            this.orientationMode = NriImgui.combo("##orientationMode", this.orientationMode,
                "Accumulated Vector Transform|Quaternion Rotation|Beam or Vertical Sprite|Basis (RTG2)");
            NriImgui.unindent();
            NriImgui.separator();

            NriImgui.text("Reorient particles:");
            NriImgui.indent();
            this.reorientParticlesInPrimaryRays = NriImgui.checkbox("In primary rays", this.reorientParticlesInPrimaryRays ? 1 : 0) != 0;
            this.reorientParticlesInSecondaryRays = NriImgui.checkbox("In secondary rays", this.reorientParticlesInSecondaryRays ? 1 : 0) != 0;
            NriImgui.unindent();
            NriImgui.separator();

            // The MLAB fragment count (the sample's combo box of 1, 2, 4, 8).
            let current = 0;
            for (let i = 0; i < 4; i++) {
                if (g_MlabFragmentCounts[i] == this.mlabFragments) {
                    current = i;
                }
            }
            NriImgui.pushItemWidth(40.0);
            const selected = NriImgui.combo("Blending fragments", current, "1|2|4|8");
            NriImgui.popItemWidth();
            if (g_MlabFragmentCounts[selected] != this.mlabFragments) {
                this.mlabFragments = g_MlabFragmentCounts[selected];
                this.updatePipeline = true;
            }
            NriImgui.separator();

            NriImgui.text("Emitter position:");
            NriImgui.indent();
            NriImgui.dragFloat3("##emitterPosition", Ref(this.emitterPosition[0]), 0.01);
            NriImgui.unindent();

            NriImgui.text("Particle texture:");
            NriImgui.indent();
            this.particleTexture = NriImgui.combo("##particleTexture", this.particleTexture, "Smoke|Logo");
            NriImgui.unindent();

            NriImgui.end();
            this.sample.imguiRender();
        }

        // The sample's Animate: the camera (its mouse unless the UI has it; nothing moves it in test mode),
        // Space, the particles (each live one moved, a new one emitted 20 times a second).
        animate() {
            if (!this.test) {
                const mouseFree = !this.imgui || NriImgui.wantsMouse() == 0;
                this.camera.mouse(this.sample, mouseFree);
                if (this.sample.isKeyToggled(NriKey.Space) != 0) {
                    this.enableAnimations = !this.enableAnimations;
                }
            }
            this.camera.animate();

            // Donut's test mode steps the animation by float(1/60) a frame.
            const elapsedSeconds = this.test ? Math.fround(1.0 / 60.0) : this.sample.getFrameTime();
            if (this.enableAnimations) {
                this.wallclockTime += elapsedSeconds;

                // Animate the live particles, also find the first empty particle slot for spawning.
                let firstEmptyParticle = -1;
                for (let i = 0; i < MAX_PARTICLES; i++) {
                    const particle = this.particles[i];

                    if (particle.active) {
                        particle.animate(elapsedSeconds);
                    }

                    if (!particle.active && firstEmptyParticle < 0) {
                        firstEmptyParticle = i;
                    }
                }

                const particlesPerSecond = 20.0;
                const particleEmissionPeriod = 1.0 / particlesPerSecond;

                // Emit a new particle if enough time has passed since the last emission.
                if (this.wallclockTime - this.lastEmitTime > particleEmissionPeriod && firstEmptyParticle >= 0) {
                    this.particles[firstEmptyParticle].emit(this.emitterPosition[0], this.emitterPosition[1], this.emitterPosition[2]);
                    this.lastEmitTime = this.wallclockTime;
                }
            }
        }

        // The UI's changes that need the device: the compute pipeline for another fragment count, the
        // particle mesh's material for another texture (the scene's material buffer made anew). False on
        // failure.
        applySettings(device: NriDevice) {
            if (this.updatePipeline) {
                if (!this.createComputePipeline(device)) {
                    return false;
                }
                this.updatePipeline = false;
            }
            const scene = this.scene;
            if (scene) {
                if (this.appliedParticleTexture != this.particleTexture) {
                    device.waitIdle();
                    this.applyParticleTexture();
                    const buffer = device.createDonutSceneBuffer(this.queue, scene, SCENE_BUFFER_MATERIALS);
                    if (!buffer) {
                        return false;
                    }
                    const view = buffer.createStructuredView(0);
                    if (!view) {
                        buffer.destroy();
                        return false;
                    }
                    this.sceneBufferViews[SCENE_BUFFER_MATERIALS].destroy();
                    this.sceneBuffers[SCENE_BUFFER_MATERIALS].destroy();
                    this.sceneBuffers[SCENE_BUFFER_MATERIALS] = buffer;
                    this.sceneBufferViews[SCENE_BUFFER_MATERIALS] = view;
                    for (const queuedFrame of this.queuedFrames) {
                        queuedFrame.set.updateDescriptor(2, 2, view);
                    }
                }
            }
            return true;
        }

        // The particle billboards (facing the camera) and ParticleInfo data, into the queued frame's
        // buffers; the particle count (Donut's buildParticleGeometry before its updateDynamicMesh).
        buildParticleGeometry(queuedFrame: QueuedFrame): int {
            // The camera's forward and up (Donut's getDirection, getUp: Animate's rotation's rows 2 and 1).
            const m = this.camera.worldToView;
            let forwardX = m[2];
            let forwardY = m[6];
            let forwardZ = m[10];
            let upX = m[1];
            let upY = m[5];
            let upZ = m[9];

            // To demonstrate beam orientation, we create vertical sprites that are free to rotate around
            // the world-space Y axis, simulating what old Doom-like games used.
            if (this.orientationMode == OrientationMode.Beam) {
                if (Math.abs(forwardY) > 0.999) {
                    forwardX = upX;
                    forwardY = upY;
                    forwardZ = upZ;
                }

                forwardY = 0.0;
                const length = Math.sqrt(forwardX * forwardX + forwardZ * forwardZ);
                forwardX /= length;
                forwardZ /= length;
                upX = 0.0;
                upY = 1.0;
                upZ = 0.0;
            }

            // cross(forward, up)
            const rightX = forwardY * upZ - forwardZ * upY;
            const rightY = forwardZ * upX - forwardX * upZ;
            const rightZ = forwardX * upY - forwardY * upX;

            const textureIndex = this.particleTextureIndices[this.particleTexture];

            let numParticles = 0;
            for (let index = 0; index < MAX_PARTICLES; index++) {
                const particle = this.particles[index];
                if (!particle.active) {
                    continue;
                }

                const baseIndex = numParticles * INDICES_PER_QUAD;
                const baseVertex = numParticles * VERTICES_PER_QUAD;

                // Indices for a quad.
                Nri.storeInt32(Ref(this.indices[baseIndex + 0]), baseVertex + 0);
                Nri.storeInt32(Ref(this.indices[baseIndex + 1]), baseVertex + 1);
                Nri.storeInt32(Ref(this.indices[baseIndex + 2]), baseVertex + 2);
                Nri.storeInt32(Ref(this.indices[baseIndex + 3]), baseVertex + 0);
                Nri.storeInt32(Ref(this.indices[baseIndex + 4]), baseVertex + 2);
                Nri.storeInt32(Ref(this.indices[baseIndex + 5]), baseVertex + 3);

                // The quad orientation in world space.
                const rotation = this.orientationMode == OrientationMode.Beam ? 0.0 : particle.rotation;
                const localRightX = Math.cos(rotation);
                const localRightY = Math.sin(rotation);
                const localUpX = -localRightY;
                const localUpY = localRightX;
                const worldRightX = localRightX * rightX + localRightY * upX;
                const worldRightY = localRightX * rightY + localRightY * upY;
                const worldRightZ = localRightX * rightZ + localRightY * upZ;
                const worldUpX = localUpX * rightX + localUpY * upX;
                const worldUpY = localUpX * rightY + localUpY * upY;
                const worldUpZ = localUpX * rightZ + localUpY * upZ;

                // Positions: corners (-right + up), (+right + up), (+right - up), (-right - up).
                const r = particle.radius;
                const p = baseVertex * 3;
                this.positions[p + 0] = particle.positionX + (-worldRightX + worldUpX) * r;
                this.positions[p + 1] = particle.positionY + (-worldRightY + worldUpY) * r;
                this.positions[p + 2] = particle.positionZ + (-worldRightZ + worldUpZ) * r;
                this.positions[p + 3] = particle.positionX + (worldRightX + worldUpX) * r;
                this.positions[p + 4] = particle.positionY + (worldRightY + worldUpY) * r;
                this.positions[p + 5] = particle.positionZ + (worldRightZ + worldUpZ) * r;
                this.positions[p + 6] = particle.positionX + (worldRightX - worldUpX) * r;
                this.positions[p + 7] = particle.positionY + (worldRightY - worldUpY) * r;
                this.positions[p + 8] = particle.positionZ + (worldRightZ - worldUpZ) * r;
                this.positions[p + 9] = particle.positionX + (-worldRightX - worldUpX) * r;
                this.positions[p + 10] = particle.positionY + (-worldRightY - worldUpY) * r;
                this.positions[p + 11] = particle.positionZ + (-worldRightZ - worldUpZ) * r;

                // Texture coordinates: (0, 0), (1, 0), (1, 1), (0, 1).
                const t = baseVertex * 2;
                this.texCoords[t + 0] = 0.0;
                this.texCoords[t + 1] = 0.0;
                this.texCoords[t + 2] = 1.0;
                this.texCoords[t + 3] = 0.0;
                this.texCoords[t + 4] = 1.0;
                this.texCoords[t + 5] = 1.0;
                this.texCoords[t + 6] = 0.0;
                this.texCoords[t + 7] = 1.0;

                // The ParticleInfo structure for the shaders, mostly for the intersection particles.
                const info = numParticles * PARTICLE_INFO_FLOATS;
                this.particleInfos[info + PARTICLE_INFO_CENTER + 0] = particle.positionX;
                this.particleInfos[info + PARTICLE_INFO_CENTER + 1] = particle.positionY;
                this.particleInfos[info + PARTICLE_INFO_CENTER + 2] = particle.positionZ;
                this.particleInfos[info + PARTICLE_INFO_ROTATION] = particle.rotation;
                this.particleInfos[info + PARTICLE_INFO_X_AXIS + 0] = worldRightX;
                this.particleInfos[info + PARTICLE_INFO_X_AXIS + 1] = worldRightY;
                this.particleInfos[info + PARTICLE_INFO_X_AXIS + 2] = worldRightZ;
                this.particleInfos[info + PARTICLE_INFO_INVERSE_RADIUS] = 1.0 / r;
                this.particleInfos[info + PARTICLE_INFO_Y_AXIS + 0] = worldUpX;
                this.particleInfos[info + PARTICLE_INFO_Y_AXIS + 1] = worldUpY;
                this.particleInfos[info + PARTICLE_INFO_Y_AXIS + 2] = worldUpZ;
                Nri.storeInt32(Ref(this.particleInfos[info + PARTICLE_INFO_TEXTURE_INDEX]), textureIndex);
                this.particleInfos[info + PARTICLE_INFO_COLOR_FACTOR + 0] = particle.colorR;
                this.particleInfos[info + PARTICLE_INFO_COLOR_FACTOR + 1] = particle.colorG;
                this.particleInfos[info + PARTICLE_INFO_COLOR_FACTOR + 2] = particle.colorB;
                this.particleInfos[info + PARTICLE_INFO_OPACITY_FACTOR] = particle.opacity;

                numParticles++;
            }

            // Donut_UpdateDynamicMesh's writes (none without particles), the ParticleInfo's.
            if (numParticles > 0) {
                const vertexCount = numParticles * VERTICES_PER_QUAD;
                queuedFrame.indexBuffer.write(0, Ref(this.indices[0]), numParticles * INDICES_PER_QUAD * 4);
                queuedFrame.vertexBuffer.write(0, Ref(this.positions[0]), vertexCount * 12);
                queuedFrame.vertexBuffer.write(TEXCOORD_OFFSET, Ref(this.texCoords[0]), vertexCount * 8);
                queuedFrame.particleInfoBuffer.write(0, Ref(this.particleInfos[0]), numParticles * PARTICLE_INFO_FLOATS * 4);
            }
            return numParticles;
        }

        // The particle mesh's BLAS rebuilt (Donut_UpdateDynamicMesh), then the TLAS: the scene's
        // instances (instance ID its index; the particle mesh with its own mask), plus one scaled AABB
        // instance per active particle for the intersection path (Donut's buildTLAS).
        recordAccelStructs(commandBuffer: NriCommandBuffer, queuedFrameIndex: int, numParticles: int) {
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            const particleBlas = this.particleBlas;
            const intersectionBlas = this.intersectionBlas;
            const topLevelAS = this.topLevelAS;
            if (!particleBlas || !intersectionBlas || !topLevelAS) {
                return;
            }
            commandBuffer.buildDynamicTriangleBlas(particleBlas, queuedFrame.vertexBuffer, 0, numParticles * VERTICES_PER_QUAD,
                queuedFrame.indexBuffer, 0, numParticles * INDICES_PER_QUAD);

            topLevelAS.clearInstances();
            for (let i = 0; i < this.sceneInstanceCount; i++) {
                topLevelAS.addInstance(this.sceneBlases[i], Ref(this.sceneTransforms[i * 12]), i, INSTANCE_MASK_OPAQUE, 0, 0);
            }
            topLevelAS.addInstance(particleBlas.getAccelerationStructure(), Ref(this.identity[0]),
                this.particleInstance, INSTANCE_MASK_PARTICLE_GEOMETRY, 0, 0);

            // scaling(float(radius)) * translation(float3(position)), as affineToColumnMajor writes it.
            let particleIndex = 0;
            for (let i = 0; i < MAX_PARTICLES; i++) {
                const particle = this.particles[i];
                if (!particle.active) {
                    continue;
                }
                const scale = Math.fround(particle.radius);
                const t = this.particleTransform;
                t[0] = scale;
                t[3] = particle.positionX;
                t[5] = scale;
                t[7] = particle.positionY;
                t[10] = scale;
                t[11] = particle.positionZ;
                topLevelAS.addInstance(intersectionBlas, Ref(t[0]), particleIndex, INSTANCE_MASK_INTERSECTION_PARTICLE, 0, 0);
                particleIndex++;
            }
            commandBuffer.buildTopLevelAS(topLevelAS, queuedFrameIndex, 0);
        }

        // The queued frame's GlobalConstants: the view (the camera's, reverse depth from 0.1, a 45 degree
        // field of view), then the sample's settings.
        writeConstants(queuedFrameIndex: int) {
            const constantBuffer = this.constantBuffer;
            if (!constantBuffer) {
                return;
            }
            const worldToView = this.camera.worldToView;
            const verticalFovRadians = Math.fround(Math.PI * 0.25);
            const projection = perspProjD3DStyleReverse(verticalFovRadians, this.width / this.height, 0.1);
            for (let i = 0; i < 16; i++) {
                this.viewMatrix[i] = worldToView[i];
                this.projMatrix[i] = projection[i];
            }
            const tail = this.viewFloats;
            Nri.fillDonutPlanarViewConstants(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), this.width, this.height,
                Ref(this.constants[0]));
            this.constants[tail + GLOBAL_PRIMARY_RAY_CONE_ANGLE] = verticalFovRadians / this.height;
            Nri.storeInt32(Ref(this.constants[tail + GLOBAL_REORIENT_PRIMARY]), this.reorientParticlesInPrimaryRays ? 1 : 0);
            Nri.storeInt32(Ref(this.constants[tail + GLOBAL_REORIENT_SECONDARY]), this.reorientParticlesInSecondaryRays ? 1 : 0);
            Nri.storeInt32(Ref(this.constants[tail + GLOBAL_ORIENTATION_MODE]), this.orientationMode);
            Nri.storeInt32(Ref(this.constants[tail + GLOBAL_ENVIRONMENT_MAP]), this.environmentMapIndex);
            constantBuffer.write(queuedFrameIndex * this.constantStride, Ref(this.constants[0]), this.constantsSize);
        }

        // The compute shader over the frame (16 x 16 pixels a group) into the color buffer, which then
        // goes to the blit.
        recordCompute(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const layout = this.layout;
            const pipeline = this.pipeline;
            const colorBuffer = this.colorBuffer;
            if (!layout || !pipeline || !colorBuffer) {
                return;
            }
            // (From its creation, already a storage texture: D3D12 wants the states to differ.)
            if (this.colorState != NriTextureState.Storage) {
                commandBuffer.textureBarrier(colorBuffer, this.colorState, NriTextureState.Storage);
            }
            commandBuffer.setComputePipelineLayout(layout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setComputeDescriptorSet(0, queuedFrame.set);
            commandBuffer.setComputeDescriptorSet(1, queuedFrame.bindlessSet);
            const textureSet = this.textureSet;
            if (textureSet) {
                commandBuffer.setComputeDescriptorSet(2, textureSet);
            }
            const groupsX: int = Math.floor((this.width + COMPUTE_GROUP_SIZE - 1) / COMPUTE_GROUP_SIZE);
            const groupsY: int = Math.floor((this.height + COMPUTE_GROUP_SIZE - 1) / COMPUTE_GROUP_SIZE);
            commandBuffer.dispatch(groupsX, groupsY, 1);
            commandBuffer.textureBarrier(colorBuffer, NriTextureState.Storage, NriTextureState.ShaderResource);
            this.colorState = NriTextureState.ShaderResource;
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain and the color buffer made again
        // at its size, once the GPU is done with the old ones, and the sets pointed at the new buffer (made
        // in the Storage state, as at first).
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
            this.destroyTargets();
            this.createTargets(device);
            this.colorState = NriTextureState.Storage;
            this.updateTargetDescriptors();
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const device = this.device;
            if (!device) {
                return;
            }
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.animate();
            if (!this.applySettings(device)) {
                return;
            }

            // The particle geometry and the acceleration structures, unless paused (and their orientation
            // too); the queued frame then reads those of the frame that built them last.
            let numParticles = -1;
            if (this.enableAnimations || this.alwaysUpdateOrientation || this.materialDirty) {
                numParticles = this.buildParticleGeometry(queuedFrame);
                this.geometrySlot = queuedFrameIndex;
                this.materialDirty = false;
            }
            if (this.geometrySlot >= 0) {
                const geometryFrame = this.queuedFrames[this.geometrySlot];
                queuedFrame.set.updateDescriptor(2, 3, geometryFrame.particleInfoView);
                queuedFrame.bindlessSet.updateDescriptor(0, BINDLESS_PARTICLE_VERTICES, geometryFrame.vertexView);
                queuedFrame.bindlessSet.updateDescriptor(0, BINDLESS_PARTICLE_INDICES, geometryFrame.indexView);
            }
            this.writeConstants(queuedFrameIndex);

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                this.recordAndSubmit(frameIndex, queuedFrameIndex, numParticles, index);
            }

            // Signaled after the present, as NRISamples do
            this.frames.signal(frameIndex);
        }

        // Records the frame into the queued frame's command buffer, submits it and presents.
        recordAndSubmit(frameIndex: int, queuedFrameIndex: int, numParticles: int, index: int) {
            const descriptorPool = this.descriptorPool;
            const blitSet = this.blitSet;
            if (!descriptorPool || !blitSet) {
                return;
            }
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            const commandBuffer = queuedFrame.commandBuffer;
            commandBuffer.begin();
            commandBuffer.setDescriptorPool(descriptorPool);
            // The first frame: the mip chains.
            this.sceneTextures.recordBlits(commandBuffer);
            this.particleTextures.recordBlits(commandBuffer);
            if (numParticles >= 0) {
                this.recordAccelStructs(commandBuffer, queuedFrameIndex, numParticles);
            }
            this.recordCompute(commandBuffer, queuedFrame);
            if (this.imgui) {
                this.sample.copyImguiData(commandBuffer);
            }

            commandBuffer.textureBarrier(this.swapChain.texture(index), NriTextureState.Undefined, NriTextureState.ColorAttachment);
            commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
            this.blit.record(commandBuffer, blitSet, this.width, this.height);
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
                    queuedFrame.constantView.destroy();
                    queuedFrame.vertexView.destroy();
                    queuedFrame.indexView.destroy();
                    queuedFrame.particleInfoView.destroy();
                    queuedFrame.vertexBuffer.destroy();
                    queuedFrame.indexBuffer.destroy();
                    queuedFrame.particleInfoBuffer.destroy();
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                for (const view of this.sceneBufferViews) {
                    view.destroy();
                }
                for (const buffer of this.sceneBuffers) {
                    buffer.destroy();
                }
                this.sceneTextures.destroy();
                this.particleTextures.destroy();
                this.destroyDescriptor(this.environmentMapView);
                const environmentMap = this.environmentMap;
                if (environmentMap) {
                    environmentMap.destroy();
                }
                this.blit.destroy();
                this.destroyDescriptor(this.anisotropicWrap);
                this.destroyTargets();
                this.destroyDescriptor(this.topLevelASView);
                const topLevelAS = this.topLevelAS;
                if (topLevelAS) {
                    topLevelAS.destroy();
                }
                const particleBlas = this.particleBlas;
                if (particleBlas) {
                    particleBlas.destroy();
                }
                const intersectionBlas = this.intersectionBlas;
                if (intersectionBlas) {
                    intersectionBlas.destroy();
                }
                const accelStructs = this.accelStructs;
                if (accelStructs) {
                    accelStructs.destroy();
                }
                const constantBuffer = this.constantBuffer;
                if (constantBuffer) {
                    constantBuffer.destroy();
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    readbackBuffer.destroy();
                }
                const pipeline = this.pipeline;
                if (pipeline) {
                    pipeline.destroy();
                }
                const layout = this.layout;
                if (layout) {
                    layout.destroy();
                }
                this.frames.destroy();
                this.swapChain.destroy();
                device.destroy();
            }
            const scene = this.scene;
            if (scene) {
                scene.destroy();
            }
            this.sample.destroy();
        }

        destroyDescriptor(descriptor: NriDescriptor | null) {
            if (descriptor) {
                descriptor.destroy();
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const example = new RtParticles(sample);
        // -noUI: no settings window (as the Donut example).
        sample.addExampleOption("-noUI");
        sample.useImgui();
        for (let i = 1; i < argc; i++) {
            if (Nri.getArg(argc, argv, i) == "-noUI") {
                example.noUI = true;
            }
        }
        return example.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return RtParticlesNri.main(argc, argv);
}

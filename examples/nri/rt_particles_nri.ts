/// <reference path="../../core/nri/nri_interop.d.ts" />
import { radians, perspProjD3DStyleReverse } from "../../core/matrix";
import { randomFloat } from "../../core/random";
import { DonutThirdPersonCamera } from "../../core/donut_third_person_camera";
import { DonutSceneTextures } from "../../core/nri_donut_textures";
import { DonutBlit } from "../../core/nri_donut_blit";

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

    // Nri_CreateDonutSceneBuffer's buffers: vertices, indices, InstanceData, GeometryData, MaterialConstants.
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
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public set: NriDescriptorSetHandle, public bindlessSet: NriDescriptorSetHandle, public constantView: NriDescriptorHandle,
            public vertexBuffer: NriBufferHandle, public vertexView: NriDescriptorHandle, public indexBuffer: NriBufferHandle,
            public indexView: NriDescriptorHandle, public particleInfoBuffer: NriBufferHandle,
            public particleInfoView: NriDescriptorHandle) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // A blit of a texture's level into the next (the mip chains Donut's TextureCache generates for files
    // without mips): the level's attachment view, the set of the level above's view.
    class MipBlit {
        constructor(public texture: NriTextureHandle, public mip: int, public width: int, public height: int,
            public attachment: NriDescriptorHandle, public sourceView: NriDescriptorHandle, public set: NriDescriptorSetHandle) {
        }
    }

    // The particle textures (sRGB PNG files) as Donut_LoadBindlessTexture loads them: each with the mip
    // chain below its first level blitted level by level with Donut's blit shaders through sRGB views.
    class ParticleTextures {
        textures: NriTextureHandle[] = [];
        views: NriDescriptorHandle[] = [];
        private blits: MipBlit[] = [];
        private blitted: boolean = false;
        private blitLayout: NriPipelineLayoutHandle | null = null;
        private blitPipeline: NriPipelineHandle | null = null;
        private linearClamp: NriDescriptorHandle | null = null;
        private blitConstants: f32[] = [];

        load(device: NriDeviceHandle, queue: NriQueueHandle, folder: string): boolean {
            for (const value of MIP_BLIT_CONSTANTS) {
                this.blitConstants.push(value);
            }
            for (const path of PARTICLE_TEXTURE_PATHS) {
                const texture = Nri_LoadImageTextureWithMipChain(device, queue, path, 1);
                if (!texture) {
                    console.log(`Cannot load the texture ${path}`);
                    return false;
                }
                this.textures.push(texture);
                this.views.push(Nri_CreateTextureView(texture, NriFormat.RGBA8_SRGB));
            }

            // Donut's blit: its constants (b0), the source (t0), linear clamp sampling (s0).
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(layoutDesc, 0, MIP_BLIT_CONSTANTS.length * 4, NriStage.Vertex);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            const layout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            this.blitLayout = layout;
            if (!layout) {
                console.log("Cannot create the blit's layout");
                return false;
            }
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `shaders/framework/${folder}/rect_vs.bin`, "main") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShaderPermutation(desc, NriShaderStage.Pixel, `shaders/framework/${folder}/blit_ps.bin`, "main",
                    "TEXTURE_ARRAY=0") != 0;
            }
            Nri_PipelineDescSetTopology(desc, NriTopology.TriangleStrip);
            Nri_PipelineDescSetColor(desc, NriFormat.RGBA8_SRGB, NriColorWrite.RGBA);
            this.blitPipeline = loaded ? Nri_CreatePipelineFromDesc(device, layout, desc) : null;
            Nri_DestroyPipelineDesc(desc);
            if (!this.blitPipeline) {
                console.log("Cannot load Donut's blit shaders");
                return false;
            }
            this.linearClamp = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
            return true;
        }

        // The sets the mip chains' blits take from a pool (a texture and a sampler each).
        blitSetCount(): int {
            let count = 0;
            for (const texture of this.textures) {
                count += Nri_GetTextureMipNum(texture) - 1;
            }
            return count;
        }

        createBlits(descriptorPool: NriDescriptorPoolHandle): boolean {
            const layout = this.blitLayout;
            const linearClamp = this.linearClamp;
            if (!layout || !linearClamp) {
                return false;
            }
            for (const texture of this.textures) {
                const mipNum = Nri_GetTextureMipNum(texture);
                const width = Nri_GetTextureWidth(texture);
                const height = Nri_GetTextureHeight(texture);
                for (let mip = 1; mip < mipNum; mip++) {
                    const set = Nri_AllocateDescriptorSet(descriptorPool, layout, 0, 0);
                    if (!set) {
                        return false;
                    }
                    const sourceView = Nri_CreateTextureMipView(texture, NriFormat.RGBA8_SRGB, mip - 1);
                    Nri_UpdateDescriptor(set, 0, 0, sourceView);
                    Nri_UpdateDescriptor(set, 1, 0, linearClamp);
                    this.blits.push(new MipBlit(texture, mip, Math.max(width >> mip, 1), Math.max(height >> mip, 1),
                        Nri_CreateColorAttachmentMipView(texture, NriFormat.RGBA8_SRGB, mip), sourceView, set));
                }
            }
            return true;
        }

        // The mip chains, once (the first frame, before the textures are read; the pool set).
        recordBlits(commandBuffer: NriCommandBufferHandle) {
            const layout = this.blitLayout;
            const pipeline = this.blitPipeline;
            if (this.blitted || !layout || !pipeline) {
                return;
            }
            for (const blit of this.blits) {
                Nri_CmdTextureMipBarrier(commandBuffer, blit.texture, blit.mip, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
                Nri_CmdBeginRendering(commandBuffer, blit.attachment);
                Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, blit.width, blit.height);
                Nri_CmdSetScissor(commandBuffer, 0, 0, blit.width, blit.height);
                Nri_CmdSetPipelineLayout(commandBuffer, layout);
                Nri_CmdSetPipeline(commandBuffer, pipeline);
                Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.blitConstants[0]), MIP_BLIT_CONSTANTS.length * 4);
                Nri_CmdSetDescriptorSet(commandBuffer, 0, blit.set);
                Nri_CmdDraw(commandBuffer, 4, 1, 0, 0);
                Nri_CmdEndRendering(commandBuffer);
                Nri_CmdTextureMipBarrier(commandBuffer, blit.texture, blit.mip, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
            }
            this.blitted = true;
        }

        // After the device is idle (the sets go with their pool).
        destroy() {
            for (const blit of this.blits) {
                Nri_DestroyDescriptor(blit.attachment);
                Nri_DestroyDescriptor(blit.sourceView);
            }
            for (const view of this.views) {
                Nri_DestroyDescriptor(view);
            }
            for (const texture of this.textures) {
                Nri_DestroyTexture(texture);
            }
            const pipeline = this.blitPipeline;
            if (pipeline) {
                Nri_DestroyPipeline(pipeline);
            }
            const layout = this.blitLayout;
            if (layout) {
                Nri_DestroyPipelineLayout(layout);
            }
            const linearClamp = this.linearClamp;
            if (linearClamp) {
                Nri_DestroyDescriptor(linearClamp);
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
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
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

        // The scene with the particle mesh: its buffers (Nri_CreateDonutSceneBuffer's) and their views,
        // its textures (the bindless array's first), its BLASes; the particle mesh's instance and
        // material; the unit AABB's BLAS; the TLAS built every frame.
        private scene: NriDonutSceneHandle | null = null;
        private sceneBuffers: NriBufferHandle[] = [];
        private sceneBufferViews: NriDescriptorHandle[] = [];
        private sceneTextures: DonutSceneTextures = new DonutSceneTextures();
        private accelStructs: NriDonutSceneAccelStructsHandle | null = null;
        private sceneInstanceCount: int = 0;
        private sceneBlases: NriAccelerationStructureHandle[] = [];
        // Each scene instance's transform, 12 floats.
        private sceneTransforms: f32[] = [];
        private particleInstance: int = 0;
        private particleMaterial: int = 0;
        private particleBlas: NriUpdatableBlasHandle | null = null;
        private intersectionBlas: NriAccelerationStructureHandle | null = null;
        private topLevelAS: NriTopLevelASHandle | null = null;
        private topLevelASView: NriDescriptorHandle | null = null;
        private identity: f32[] = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        private particleTransform: f32[] = zeros(12);

        // The environment map and the particle textures, after the scene's in the bindless texture array.
        private environmentMap: NriTextureHandle | null = null;
        private environmentMapView: NriDescriptorHandle | null = null;
        private particleTextures: ParticleTextures = new ParticleTextures();
        private textureViews: NriDescriptorHandle[] = [];
        private environmentMapIndex: int = 0;
        private particleTextureIndices: int[] = [];
        // The particle texture last given to the particle mesh's material, and whether the scene has yet
        // to see it.
        private appliedParticleTexture: int = -1;
        private materialDirty: boolean = false;

        // The compute pass: its layout, its pipeline ((re)created when updatePipeline is set), the color
        // buffer it writes (RGBA16F; the state it's in between frames), the sampler, the blit.
        private layout: NriPipelineLayoutHandle | null = null;
        private pipeline: NriPipelineHandle | null = null;
        private textureSet: NriDescriptorSetHandle | null = null;
        private colorBuffer: NriTextureHandle | null = null;
        private colorStorage: NriDescriptorHandle | null = null;
        private colorView: NriDescriptorHandle | null = null;
        private colorState: NriTextureState = NriTextureState.Storage;
        private anisotropicWrap: NriDescriptorHandle | null = null;
        private blit: DonutBlit = new DonutBlit();
        private blitSet: NriDescriptorSetHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private constantBuffer: NriBufferHandle | null = null;
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
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
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
            Nri_SetInitializeCallback(this.sample, initialize);
            Nri_SetLatencySleepCallback(this.sample, latencySleep);
            Nri_SetRenderFrameCallback(this.sample, renderFrame);

            let result = Nri_RunSample(this.sample, argc, argv, WINDOW_TITLE, TEST_FRAMES);
            if (this.unsupportedReason != "") {
                const test = Nri_IsTest(this.sample) != 0;
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
            const device = Nri_CreateDevice(this.sample, graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri_GetGraphicsAPIString(graphicsAPI)} (${Nri_GetAdapterName(device)})`);

            this.queue = Nri_GetGraphicsQueue(device);
            this.frameFence = Nri_CreateFence(device, 0);
            this.test = Nri_IsTest(this.sample) != 0;

            // Swap chain: blitted into through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.createSwapChain(device);
            const format = this.swapChainFormat;
            this.viewFormat = this.swapChainViewFormat;

            // Ray queries: D3D12 or Vulkan (the Donut example's shaders have no DXBC).
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "No D3D11 shaders (ray queries need D3D12 or Vulkan)";
                return 0;
            }
            if (Nri_IsFeatureSupported(device, NriFeature.RayQuery) == 0) {
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
                if (Nri_InitImgui(this.sample, device) == 0) {
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
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The environment map and the particle textures (Donut_LoadBindlessTexture's).
        loadTextures(device: NriDeviceHandle) {
            const environmentMap = Nri_LoadDdsTexture(device, this.queue, ENVIRONMENT_MAP_PATH, 0);
            this.environmentMap = environmentMap;
            if (!environmentMap) {
                console.log("Cannot load the particle textures");
                return false;
            }
            this.environmentMapView = Nri_CreateTextureView(environmentMap, Nri_GetTextureFormat(environmentMap));
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
        loadScene(device: NriDeviceHandle, queuedFrameNum: int) {
            const scene = Nri_LoadDonutScene(SCENE_PATH);
            this.scene = scene;
            if (!scene) {
                console.log(`Cannot load the scene ${SCENE_PATH}`);
                return false;
            }
            if (Nri_GetDonutSceneNodePosition(SCENE_PATH, "/Emitter", Ref(this.emitterPosition[0])) == 0) {
                console.log("The scene has no emitter node");
            }

            // Donut_BuildSceneBLASes: the scene's meshes' (the particle mesh has its own).
            const accelStructs = Nri_BuildDonutSceneAccelStructs(device, this.queue, scene);
            this.accelStructs = accelStructs;
            if (!accelStructs) {
                console.log("Cannot build the scene's acceleration structures");
                return false;
            }
            this.sceneInstanceCount = Nri_GetDonutSceneInstanceCount(scene);
            for (let i = 0; i < this.sceneInstanceCount; i++) {
                const blas = Nri_GetDonutSceneInstanceBlas(scene, accelStructs, i);
                if (!blas) {
                    console.log("Cannot build the scene's acceleration structures");
                    return false;
                }
                this.sceneBlases.push(blas);
                for (let k = 0; k < 12; k++) {
                    this.sceneTransforms.push(0.0);
                }
                Nri_GetDonutSceneInstanceTransform(scene, i, Ref(this.sceneTransforms[i * 12]));
            }

            this.particleInstance = Nri_AddDonutSceneDynamicMesh(scene, MAX_VERTICES, MAX_INDICES, BINDLESS_PARTICLE_VERTICES,
                BINDLESS_PARTICLE_INDICES);
            this.particleMaterial = Nri_GetDonutSceneGeometryMaterial(scene, this.particleInstance, 0);

            // The bindless textures: the scene's (its materials' numbers), the environment map, the particle
            // textures.
            if (!this.sceneTextures.load(device, this.queue, scene, this.folder)) {
                return false;
            }
            for (const view of this.sceneTextures.views) {
                this.textureViews.push(view);
            }
            const environmentMapView = this.environmentMapView;
            if (!environmentMapView) {
                return false;
            }
            this.environmentMapIndex = this.textureViews.length;
            this.textureViews.push(environmentMapView);
            for (const view of this.particleTextures.views) {
                this.particleTextureIndices.push(this.textureViews.length);
                this.textureViews.push(view);
            }

            // Its texture set before the scene's buffers are made (Donut's first onRender, before the
            // first refreshScene).
            this.applyParticleTexture();
            for (let which = 0; which < SCENE_BUFFER_COUNT; which++) {
                const buffer = Nri_CreateDonutSceneBuffer(device, this.queue, scene, which);
                if (!buffer) {
                    console.log("Cannot create the scene's buffers");
                    return false;
                }
                this.sceneBuffers.push(buffer);
                const view = Nri_CreateStructuredBufferView(buffer, 0);
                if (!view) {
                    console.log("Cannot create the scene's buffers");
                    return false;
                }
                this.sceneBufferViews.push(view);
            }

            // Donut_CreateDynamicMesh's BLAS (GetMeshBlasDesc's: non-opaque, its material being alpha-blended;
            // prefer fast trace), the unit AABB's (Donut_CreateUnitAABBBlas'), the TLAS (the scene's
            // instances, the particle mesh's included, plus one per particle).
            this.particleBlas = Nri_CreateDynamicTriangleBlas(device, MAX_VERTICES, 12, MAX_INDICES, PREFER_FAST_TRACE, 0);
            const desc = Nri_CreateBlasDesc();
            const aabb: f32[] = [-1.0, -1.0, -1.0, 1.0, 1.0, 1.0];
            Nri_BlasDescAddAabbs(desc, Ref(aabb[0]), 1);
            this.intersectionBlas = Nri_BuildBlasFromDesc(device, this.queue, desc, NriAccelerationStructureFlags.None);
            Nri_DestroyBlasDesc(desc);
            const topLevelAS = Nri_CreateTopLevelAS(device, Nri_GetDonutSceneInstanceCount(scene) + MAX_PARTICLES,
                NriAccelerationStructureFlags.None, queuedFrameNum);
            this.topLevelAS = topLevelAS;
            if (!this.particleBlas || !this.intersectionBlas || !topLevelAS) {
                console.log("Cannot create the particles' acceleration structures");
                return false;
            }
            this.topLevelASView = Nri_CreateAccelerationStructureDescriptor(Nri_GetTopLevelAccelerationStructure(topLevelAS));
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
            Nri_SetDonutSceneMaterialBaseTexture(scene, this.particleMaterial, this.particleTextureIndices[this.particleTexture]);
            this.appliedParticleTexture = this.particleTexture;
            this.materialDirty = true;
        }

        // The color buffer the compute shader writes (createUAVTextureForFrameWithFormat's RGBA16F).
        createTargets(device: NriDeviceHandle) {
            const colorBuffer = Nri_CreateStorageTexture(device, this.queue, this.width, this.height, NriFormat.RGBA16_SFLOAT);
            this.colorBuffer = colorBuffer;
            if (!colorBuffer) {
                console.log("Cannot create the color buffer");
                return false;
            }
            this.colorStorage = Nri_CreateStorageTextureView(colorBuffer, NriFormat.RGBA16_SFLOAT);
            this.colorView = Nri_CreateTextureView(colorBuffer, NriFormat.RGBA16_SFLOAT);
            return true;
        }

        destroyTargets() {
            this.destroyDescriptor(this.colorStorage);
            this.destroyDescriptor(this.colorView);
            this.colorStorage = null;
            this.colorView = null;
            const colorBuffer = this.colorBuffer;
            if (colorBuffer) {
                Nri_DestroyTexture(colorBuffer);
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
                Nri_UpdateDescriptor(queuedFrame.set, 4, 0, colorStorage);
            }
            const blitSet = this.blitSet;
            if (blitSet) {
                Nri_UpdateDescriptor(blitSet, 0, 0, colorView);
            }
        }

        // The compute shader's bindings: set 0 the constants (b0), the TLAS (t0), the InstanceData,
        // GeometryData, MaterialConstants and ParticleInfo (t1 to t4), the sampler (s0), the color buffer
        // (u0); the bindless arrays: on Vulkan set 1, the buffers at binding 0 and the textures at 1 (the
        // shader's vk::binding), on D3D12 spaces 1 and 2.
        createLayout(device: NriDeviceHandle) {
            const textureCount = this.textureViews.length;
            const arrayFlags = NriRangeFlags.PartiallyBound | NriRangeFlags.Array;
            const desc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(desc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Compute, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(desc, 0, 0, 1, NriDescriptorType.AccelerationStructure, NriStage.Compute, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(desc, 0, 1, 4, NriDescriptorType.StructuredBuffer, NriStage.Compute, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(desc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Compute, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(desc, 0, 0, 1, NriDescriptorType.StorageTexture, NriStage.Compute, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(desc, 1, 0, BINDLESS_BUFFER_COUNT, NriDescriptorType.StructuredBuffer, NriStage.Compute, arrayFlags);
            if (this.vulkan) {
                Nri_PipelineLayoutDescAddRange(desc, 1, 1, textureCount, NriDescriptorType.Texture, NriStage.Compute, arrayFlags);
            } else {
                Nri_PipelineLayoutDescAddRange(desc, 2, 0, textureCount, NriDescriptorType.Texture, NriStage.Compute, arrayFlags);
            }
            this.layout = Nri_CreatePipelineLayoutFromDesc(device, desc);
            Nri_DestroyPipelineLayoutDesc(desc);
            if (!this.layout) {
                console.log("Cannot create the pipeline layout");
                return false;
            }
            return true;
        }

        // The compute pipeline for mlabFragments (Donut's createShaderWithDefine of MLAB_FRAGMENTS); false on
        // failure. The old one, if any, after the device is idle.
        createComputePipeline(device: NriDeviceHandle) {
            const layout = this.layout;
            if (!layout) {
                return false;
            }
            const oldPipeline = this.pipeline;
            if (oldPipeline) {
                Nri_DeviceWaitIdle(device);
                Nri_DestroyPipeline(oldPipeline);
                this.pipeline = null;
            }
            this.pipeline = Nri_CreateComputePipelinePermutation(device, layout, `shaders/rt_particles/${this.folder}/rt_particles.bin`,
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
        createDescriptorSets(device: NriDeviceHandle, queuedFrameNum: int) {
            const layout = this.layout;
            const topLevelASView = this.topLevelASView;
            const colorStorage = this.colorStorage;
            const colorView = this.colorView;
            if (!layout || !topLevelASView || !colorStorage || !colorView) {
                return false;
            }
            const anisotropicWrap = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.Repeat, 16);
            this.anisotropicWrap = anisotropicWrap;

            this.viewFloats = Nri_GetDonutConstantsSize(0) / 4;
            this.constantsSize = (this.viewFloats + GLOBAL_TAIL_FLOATS) * 4;
            this.constants = zeros(this.viewFloats + GLOBAL_TAIL_FLOATS);
            this.constantStride = align(this.constantsSize);
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * this.constantStride, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;

            const textureCount = this.textureViews.length;
            const blitCount = this.sceneTextures.blitSetCount() + this.particleTextures.blitSetCount();
            const descriptorPool = Nri_CreateDescriptorPoolWithAccelerationStructures(device,
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

            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const set = Nri_AllocateDescriptorSet(descriptorPool, layout, 0, 0);
                const bindlessSet = Nri_AllocateDescriptorSet(descriptorPool, layout, 1, 0);
                const constantView = Nri_CreateConstantBufferView(constantBuffer, i * this.constantStride, this.constantStride);
                // The particle mesh's buffers (raw, read by the shader and the BLAS build) and the
                // ParticleInfo structures, written by the CPU every frame.
                const vertexBuffer = Nri_CreateHostBufferWithStride(device, VERTEX_BUFFER_SIZE, NriBufferUsage.AccelerationStructureInput, 4);
                const indexBuffer = Nri_CreateHostBufferWithStride(device, MAX_INDICES * 4, NriBufferUsage.AccelerationStructureInput, 4);
                const particleInfoBuffer = Nri_CreateHostBufferWithStride(device, MAX_PARTICLES * PARTICLE_INFO_FLOATS * 4,
                    NriBufferUsage.StructuredBuffer, PARTICLE_INFO_FLOATS * 4);
                if (!set || !bindlessSet || !constantView || !vertexBuffer || !indexBuffer || !particleInfoBuffer) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                const vertexView = Nri_CreateStructuredBufferView(vertexBuffer, 0);
                const indexView = Nri_CreateStructuredBufferView(indexBuffer, 0);
                const particleInfoView = Nri_CreateStructuredBufferView(particleInfoBuffer, 0);
                if (!vertexView || !indexView || !particleInfoView) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), set, bindlessSet,
                    constantView, vertexBuffer, vertexView, indexBuffer, indexView, particleInfoBuffer, particleInfoView));

                Nri_UpdateDescriptor(set, 0, 0, constantView);
                Nri_UpdateDescriptor(set, 1, 0, topLevelASView);
                for (let k = 0; k < 3; k++) {
                    Nri_UpdateDescriptor(set, 2, k, this.sceneBufferViews[2 + k]);
                }
                Nri_UpdateDescriptor(set, 2, 3, particleInfoView);
                Nri_UpdateDescriptor(set, 3, 0, anisotropicWrap);
                Nri_UpdateDescriptor(set, 4, 0, colorStorage);
                Nri_UpdateDescriptor(bindlessSet, 0, BINDLESS_SCENE_VERTICES, this.sceneBufferViews[0]);
                Nri_UpdateDescriptor(bindlessSet, 0, BINDLESS_SCENE_INDICES, this.sceneBufferViews[1]);
                Nri_UpdateDescriptor(bindlessSet, 0, BINDLESS_PARTICLE_VERTICES, vertexView);
                Nri_UpdateDescriptor(bindlessSet, 0, BINDLESS_PARTICLE_INDICES, indexView);
                if (this.vulkan) {
                    for (let t = 0; t < textureCount; t++) {
                        Nri_UpdateDescriptor(bindlessSet, 1, t, this.textureViews[t]);
                    }
                }
            }
            if (!this.vulkan) {
                const textureSet = Nri_AllocateDescriptorSet(descriptorPool, layout, 2, 0);
                this.textureSet = textureSet;
                if (!textureSet) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                for (let t = 0; t < textureCount; t++) {
                    Nri_UpdateDescriptor(textureSet, 0, t, this.textureViews[t]);
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
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The settings window (the sample's UserInterface).
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPos(10.0, 10.0);
            Nri_ImguiBegin("Settings", 1);

            this.enableAnimations = Nri_ImguiCheckbox("Animate particles (Space)", this.enableAnimations ? 1 : 0) != 0;
            this.alwaysUpdateOrientation = Nri_ImguiCheckbox("Update orientation when paused", this.alwaysUpdateOrientation ? 1 : 0) != 0;
            Nri_ImguiSeparator();

            Nri_ImguiText("Orientation mode:");
            Nri_ImguiIndent();
            this.orientationMode = Nri_ImguiCombo("##orientationMode", this.orientationMode,
                "Accumulated Vector Transform|Quaternion Rotation|Beam or Vertical Sprite|Basis (RTG2)");
            Nri_ImguiUnindent();
            Nri_ImguiSeparator();

            Nri_ImguiText("Reorient particles:");
            Nri_ImguiIndent();
            this.reorientParticlesInPrimaryRays = Nri_ImguiCheckbox("In primary rays", this.reorientParticlesInPrimaryRays ? 1 : 0) != 0;
            this.reorientParticlesInSecondaryRays = Nri_ImguiCheckbox("In secondary rays", this.reorientParticlesInSecondaryRays ? 1 : 0) != 0;
            Nri_ImguiUnindent();
            Nri_ImguiSeparator();

            // The MLAB fragment count (the sample's combo box of 1, 2, 4, 8).
            let current = 0;
            for (let i = 0; i < 4; i++) {
                if (g_MlabFragmentCounts[i] == this.mlabFragments) {
                    current = i;
                }
            }
            Nri_ImguiPushItemWidth(40.0);
            const selected = Nri_ImguiCombo("Blending fragments", current, "1|2|4|8");
            Nri_ImguiPopItemWidth();
            if (g_MlabFragmentCounts[selected] != this.mlabFragments) {
                this.mlabFragments = g_MlabFragmentCounts[selected];
                this.updatePipeline = true;
            }
            Nri_ImguiSeparator();

            Nri_ImguiText("Emitter position:");
            Nri_ImguiIndent();
            Nri_ImguiDragFloat3("##emitterPosition", Ref(this.emitterPosition[0]), 0.01);
            Nri_ImguiUnindent();

            Nri_ImguiText("Particle texture:");
            Nri_ImguiIndent();
            this.particleTexture = Nri_ImguiCombo("##particleTexture", this.particleTexture, "Smoke|Logo");
            Nri_ImguiUnindent();

            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        // The sample's Animate: the camera (its mouse unless the UI has it; nothing moves it in test mode),
        // Space, the particles (each live one moved, a new one emitted 20 times a second).
        animate() {
            if (!this.test) {
                const mouseFree = !this.imgui || Nri_ImguiWantsMouse() == 0;
                this.camera.mouse(this.sample, mouseFree);
                if (Nri_IsKeyToggled(this.sample, NriKey.Space) != 0) {
                    this.enableAnimations = !this.enableAnimations;
                }
            }
            this.camera.animate();

            // Donut's test mode steps the animation by float(1/60) a frame.
            const elapsedSeconds = this.test ? Math.fround(1.0 / 60.0) : Nri_GetFrameTime(this.sample);
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
        applySettings(device: NriDeviceHandle) {
            if (this.updatePipeline) {
                if (!this.createComputePipeline(device)) {
                    return false;
                }
                this.updatePipeline = false;
            }
            const scene = this.scene;
            if (scene) {
                if (this.appliedParticleTexture != this.particleTexture) {
                    Nri_DeviceWaitIdle(device);
                    this.applyParticleTexture();
                    const buffer = Nri_CreateDonutSceneBuffer(device, this.queue, scene, SCENE_BUFFER_MATERIALS);
                    if (!buffer) {
                        return false;
                    }
                    const view = Nri_CreateStructuredBufferView(buffer, 0);
                    if (!view) {
                        Nri_DestroyBuffer(buffer);
                        return false;
                    }
                    Nri_DestroyDescriptor(this.sceneBufferViews[SCENE_BUFFER_MATERIALS]);
                    Nri_DestroyBuffer(this.sceneBuffers[SCENE_BUFFER_MATERIALS]);
                    this.sceneBuffers[SCENE_BUFFER_MATERIALS] = buffer;
                    this.sceneBufferViews[SCENE_BUFFER_MATERIALS] = view;
                    for (const queuedFrame of this.queuedFrames) {
                        Nri_UpdateDescriptor(queuedFrame.set, 2, 2, view);
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
                Nri_StoreInt32(Ref(this.indices[baseIndex + 0]), baseVertex + 0);
                Nri_StoreInt32(Ref(this.indices[baseIndex + 1]), baseVertex + 1);
                Nri_StoreInt32(Ref(this.indices[baseIndex + 2]), baseVertex + 2);
                Nri_StoreInt32(Ref(this.indices[baseIndex + 3]), baseVertex + 0);
                Nri_StoreInt32(Ref(this.indices[baseIndex + 4]), baseVertex + 2);
                Nri_StoreInt32(Ref(this.indices[baseIndex + 5]), baseVertex + 3);

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
                Nri_StoreInt32(Ref(this.particleInfos[info + PARTICLE_INFO_TEXTURE_INDEX]), textureIndex);
                this.particleInfos[info + PARTICLE_INFO_COLOR_FACTOR + 0] = particle.colorR;
                this.particleInfos[info + PARTICLE_INFO_COLOR_FACTOR + 1] = particle.colorG;
                this.particleInfos[info + PARTICLE_INFO_COLOR_FACTOR + 2] = particle.colorB;
                this.particleInfos[info + PARTICLE_INFO_OPACITY_FACTOR] = particle.opacity;

                numParticles++;
            }

            // Donut_UpdateDynamicMesh's writes (none without particles), the ParticleInfo's.
            if (numParticles > 0) {
                const vertexCount = numParticles * VERTICES_PER_QUAD;
                Nri_WriteBuffer(queuedFrame.indexBuffer, 0, Ref(this.indices[0]), numParticles * INDICES_PER_QUAD * 4);
                Nri_WriteBuffer(queuedFrame.vertexBuffer, 0, Ref(this.positions[0]), vertexCount * 12);
                Nri_WriteBuffer(queuedFrame.vertexBuffer, TEXCOORD_OFFSET, Ref(this.texCoords[0]), vertexCount * 8);
                Nri_WriteBuffer(queuedFrame.particleInfoBuffer, 0, Ref(this.particleInfos[0]), numParticles * PARTICLE_INFO_FLOATS * 4);
            }
            return numParticles;
        }

        // The particle mesh's BLAS rebuilt (Donut_UpdateDynamicMesh), then the TLAS: the scene's
        // instances (instance ID its index; the particle mesh with its own mask), plus one scaled AABB
        // instance per active particle for the intersection path (Donut's buildTLAS).
        recordAccelStructs(commandBuffer: NriCommandBufferHandle, queuedFrameIndex: int, numParticles: int) {
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            const particleBlas = this.particleBlas;
            const intersectionBlas = this.intersectionBlas;
            const topLevelAS = this.topLevelAS;
            if (!particleBlas || !intersectionBlas || !topLevelAS) {
                return;
            }
            Nri_CmdBuildDynamicTriangleBlas(commandBuffer, particleBlas, queuedFrame.vertexBuffer, 0, numParticles * VERTICES_PER_QUAD,
                queuedFrame.indexBuffer, 0, numParticles * INDICES_PER_QUAD);

            Nri_TopLevelASClearInstances(topLevelAS);
            for (let i = 0; i < this.sceneInstanceCount; i++) {
                Nri_TopLevelASAddInstance(topLevelAS, this.sceneBlases[i], Ref(this.sceneTransforms[i * 12]), i, INSTANCE_MASK_OPAQUE, 0, 0);
            }
            Nri_TopLevelASAddInstance(topLevelAS, Nri_GetUpdatableBlasAccelerationStructure(particleBlas), Ref(this.identity[0]),
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
                Nri_TopLevelASAddInstance(topLevelAS, intersectionBlas, Ref(t[0]), particleIndex, INSTANCE_MASK_INTERSECTION_PARTICLE, 0, 0);
                particleIndex++;
            }
            Nri_CmdBuildTopLevelAS(commandBuffer, topLevelAS, queuedFrameIndex, 0);
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
            Nri_FillDonutPlanarViewConstants(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), this.width, this.height,
                Ref(this.constants[0]));
            this.constants[tail + GLOBAL_PRIMARY_RAY_CONE_ANGLE] = verticalFovRadians / this.height;
            Nri_StoreInt32(Ref(this.constants[tail + GLOBAL_REORIENT_PRIMARY]), this.reorientParticlesInPrimaryRays ? 1 : 0);
            Nri_StoreInt32(Ref(this.constants[tail + GLOBAL_REORIENT_SECONDARY]), this.reorientParticlesInSecondaryRays ? 1 : 0);
            Nri_StoreInt32(Ref(this.constants[tail + GLOBAL_ORIENTATION_MODE]), this.orientationMode);
            Nri_StoreInt32(Ref(this.constants[tail + GLOBAL_ENVIRONMENT_MAP]), this.environmentMapIndex);
            Nri_WriteBuffer(constantBuffer, queuedFrameIndex * this.constantStride, Ref(this.constants[0]), this.constantsSize);
        }

        // The compute shader over the frame (16 x 16 pixels a group) into the color buffer, which then
        // goes to the blit.
        recordCompute(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const layout = this.layout;
            const pipeline = this.pipeline;
            const colorBuffer = this.colorBuffer;
            if (!layout || !pipeline || !colorBuffer) {
                return;
            }
            // (From its creation, already a storage texture: D3D12 wants the states to differ.)
            if (this.colorState != NriTextureState.Storage) {
                Nri_CmdTextureBarrier(commandBuffer, colorBuffer, this.colorState, NriTextureState.Storage);
            }
            Nri_CmdSetComputePipelineLayout(commandBuffer, layout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetComputeDescriptorSet(commandBuffer, 0, queuedFrame.set);
            Nri_CmdSetComputeDescriptorSet(commandBuffer, 1, queuedFrame.bindlessSet);
            const textureSet = this.textureSet;
            if (textureSet) {
                Nri_CmdSetComputeDescriptorSet(commandBuffer, 2, textureSet);
            }
            const groupsX: int = Math.floor((this.width + COMPUTE_GROUP_SIZE - 1) / COMPUTE_GROUP_SIZE);
            const groupsY: int = Math.floor((this.height + COMPUTE_GROUP_SIZE - 1) / COMPUTE_GROUP_SIZE);
            Nri_CmdDispatch(commandBuffer, groupsX, groupsY, 1);
            Nri_CmdTextureBarrier(commandBuffer, colorBuffer, NriTextureState.Storage, NriTextureState.ShaderResource);
            this.colorState = NriTextureState.ShaderResource;
        }

        // The swap chain at the window's size, its textures' views and semaphores.
        createSwapChain(device: NriDeviceHandle) {
            this.width = Nri_GetOutputWidth(this.sample);
            this.height = Nri_GetOutputHeight(this.sample);
            this.swapChain = Nri_CreateSwapChain(this.sample, device, this.queue, Nri_GetQueuedFrameNum(this.sample) + 1);
            const textureNum = Nri_GetSwapChainTextureNum(this.swapChain);
            this.swapChainFormat = Nri_GetTextureFormat(Nri_GetSwapChainTexture(this.swapChain, 0));
            this.swapChainViewFormat = Nri_GetSrgbFormat(this.swapChainFormat);
            for (let i = 0; i < textureNum; i++) {
                const texture = Nri_GetSwapChainTexture(this.swapChain, i);
                this.swapChainTextures.push(new SwapChainTexture(texture, Nri_CreateColorAttachmentView(texture, this.swapChainViewFormat),
                    Nri_CreateSwapChainSemaphore(device), Nri_CreateSwapChainSemaphore(device)));
            }
        }

        destroySwapChain() {
            for (const swapChainTexture of this.swapChainTextures) {
                Nri_DestroyFence(swapChainTexture.acquireSemaphore);
                Nri_DestroyFence(swapChainTexture.releaseSemaphore);
                Nri_DestroyDescriptor(swapChainTexture.colorAttachment);
            }
            this.swapChainTextures = [];
            Nri_DestroySwapChain(this.swapChain);
        }

        // The window was resized (Nri_UseResizableWindow): the swap chain and the color buffer made again
        // at its size, once the GPU is done with the old ones, and the sets pointed at the new buffer (made
        // in the Storage state, as at first).
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (Nri_GetOutputWidth(this.sample) == this.width && Nri_GetOutputHeight(this.sample) == this.height) {
                return;
            }
            Nri_DeviceWaitIdle(device);
            this.destroySwapChain();
            this.createSwapChain(device);
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
                Nri_UpdateDescriptor(queuedFrame.set, 2, 3, geometryFrame.particleInfoView);
                Nri_UpdateDescriptor(queuedFrame.bindlessSet, 0, BINDLESS_PARTICLE_VERTICES, geometryFrame.vertexView);
                Nri_UpdateDescriptor(queuedFrame.bindlessSet, 0, BINDLESS_PARTICLE_INDICES, geometryFrame.indexView);
            }
            this.writeConstants(queuedFrameIndex);

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                this.recordAndSubmit(frameIndex, queuedFrameIndex, numParticles, this.swapChainTextures[index], acquireSemaphore);
            }

            // Signaled after the present, as NRISamples do
            Nri_QueueSignal(this.queue, this.frameFence, 1 + frameIndex);
        }

        // Records the frame into the queued frame's command buffer, submits it and presents.
        recordAndSubmit(frameIndex: int, queuedFrameIndex: int, numParticles: int, swapChainTexture: SwapChainTexture,
            acquireSemaphore: NriFenceHandle) {
            const descriptorPool = this.descriptorPool;
            const blitSet = this.blitSet;
            if (!descriptorPool || !blitSet) {
                return;
            }
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            const commandBuffer = queuedFrame.commandBuffer;
            Nri_BeginCommandBuffer(commandBuffer);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            // The first frame: the mip chains.
            this.sceneTextures.recordBlits(commandBuffer);
            this.particleTextures.recordBlits(commandBuffer);
            if (numParticles >= 0) {
                this.recordAccelStructs(commandBuffer, queuedFrameIndex, numParticles);
            }
            this.recordCompute(commandBuffer, queuedFrame);
            if (this.imgui) {
                Nri_CmdCopyImguiData(this.sample, commandBuffer);
            }

            Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
            Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
            this.blit.record(commandBuffer, blitSet, this.width, this.height);
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
                    Nri_DestroyDescriptor(queuedFrame.constantView);
                    Nri_DestroyDescriptor(queuedFrame.vertexView);
                    Nri_DestroyDescriptor(queuedFrame.indexView);
                    Nri_DestroyDescriptor(queuedFrame.particleInfoView);
                    Nri_DestroyBuffer(queuedFrame.vertexBuffer);
                    Nri_DestroyBuffer(queuedFrame.indexBuffer);
                    Nri_DestroyBuffer(queuedFrame.particleInfoBuffer);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    Nri_DestroyDescriptorPool(descriptorPool);
                }
                for (const view of this.sceneBufferViews) {
                    Nri_DestroyDescriptor(view);
                }
                for (const buffer of this.sceneBuffers) {
                    Nri_DestroyBuffer(buffer);
                }
                this.sceneTextures.destroy();
                this.particleTextures.destroy();
                this.destroyDescriptor(this.environmentMapView);
                const environmentMap = this.environmentMap;
                if (environmentMap) {
                    Nri_DestroyTexture(environmentMap);
                }
                this.blit.destroy();
                this.destroyDescriptor(this.anisotropicWrap);
                this.destroyTargets();
                this.destroyDescriptor(this.topLevelASView);
                const topLevelAS = this.topLevelAS;
                if (topLevelAS) {
                    Nri_DestroyTopLevelAS(topLevelAS);
                }
                const particleBlas = this.particleBlas;
                if (particleBlas) {
                    Nri_DestroyUpdatableBlas(particleBlas);
                }
                const intersectionBlas = this.intersectionBlas;
                if (intersectionBlas) {
                    Nri_DestroyAccelerationStructure(intersectionBlas);
                }
                const accelStructs = this.accelStructs;
                if (accelStructs) {
                    Nri_DestroyDonutSceneAccelStructs(accelStructs);
                }
                const constantBuffer = this.constantBuffer;
                if (constantBuffer) {
                    Nri_DestroyBuffer(constantBuffer);
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    Nri_DestroyBuffer(readbackBuffer);
                }
                const pipeline = this.pipeline;
                if (pipeline) {
                    Nri_DestroyPipeline(pipeline);
                }
                const layout = this.layout;
                if (layout) {
                    Nri_DestroyPipelineLayout(layout);
                }
                Nri_DestroyFence(this.frameFence);
                this.destroySwapChain();
                Nri_DestroyDevice(device);
            }
            const scene = this.scene;
            if (scene) {
                Nri_DestroyDonutScene(scene);
            }
            Nri_DestroySample(this.sample);
        }

        destroyDescriptor(descriptor: NriDescriptorHandle | null) {
            if (descriptor) {
                Nri_DestroyDescriptor(descriptor);
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        Nri_UseResizableWindow(sample);
        const example = new RtParticles(sample);
        // -noUI: no settings window (as the Donut example).
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            if (Nri_GetArg(argc, argv, i) == "-noUI") {
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

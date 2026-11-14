/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { perspProjD3DStyle, radiansF32, translation } from "../../core/matrix";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace DeferredShadingNri {
    // deferred_shading, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: Donut's own passes' shaders (its G-buffer fill, deferred lighting and blit
    // shaders, as Donut compiles them), with their constants filled as Donut's engine fills them
    // (core/nri/nri_donut_constants.cpp), through the NRI calls core/nri/nri_interop.d.ts binds. This
    // example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Deferred Shading";

    // The cube's texture (the Donut example's), loaded as sRGB.
    const TEXTURE_PATH = "media/nvidia-logo.png";

    // -test: checks the last frame, read back, as the Donut example does. The corners are black; the
    // cube, shaded from the G-buffer, covers about 18% of the frame, its middle included.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const xs = [0, width - 1, 0, width - 1];
        const ys = [0, 0, height - 1, height - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[ys[k] * width + xs[k]] & 0xFFFFFF;
            if (p != 0) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not black`;
            }
        }
        if ((pixels[Math.floor(height / 2) * width + Math.floor(width / 2)] & 0xFFFFFF) == 0) {
            return "no cube in the middle";
        }
        let cube = 0;
        for (let i = 0; i < width * height; i++) {
            if ((pixels[i] & 0xFFFFFF) != 0) {
                cube++;
            }
        }
        const percent = 100.0 * cube / (width * height);
        console.log(`Cube: ${percent}% (${cube} of ${width * height} pixels)`);
        if (percent < 12.0 || percent > 24.0) {
            return `Cube: ${percent}% of the pixels, not 12% to 24%`;
        }
        return "";
    }

    // --- Model --------------------------------------------------------------------------------

    const VERTEX_COUNT = 24;
    const INDEX_COUNT = 36;

    const g_Positions: f32[] = [
        -0.5,  0.5, -0.5, // front face
         0.5, -0.5, -0.5,
        -0.5, -0.5, -0.5,
         0.5,  0.5, -0.5,

         0.5, -0.5, -0.5, // right side face
         0.5,  0.5,  0.5,
         0.5, -0.5,  0.5,
         0.5,  0.5, -0.5,

        -0.5,  0.5,  0.5, // left side face
        -0.5, -0.5, -0.5,
        -0.5, -0.5,  0.5,
        -0.5,  0.5, -0.5,

         0.5,  0.5,  0.5, // back face
        -0.5, -0.5,  0.5,
         0.5, -0.5,  0.5,
        -0.5,  0.5,  0.5,

        -0.5,  0.5, -0.5, // top face
         0.5,  0.5,  0.5,
         0.5,  0.5, -0.5,
        -0.5,  0.5,  0.5,

         0.5, -0.5,  0.5, // bottom face
        -0.5, -0.5, -0.5,
         0.5, -0.5, -0.5,
        -0.5, -0.5,  0.5,
    ];

    const g_TexCoords: f32[] = [
        0.0, 0.0, // front face
        1.0, 1.0,
        0.0, 1.0,
        1.0, 0.0,

        0.0, 1.0, // right side face
        1.0, 0.0,
        1.0, 1.0,
        0.0, 0.0,

        0.0, 0.0, // left side face
        1.0, 1.0,
        0.0, 1.0,
        1.0, 0.0,

        0.0, 0.0, // back face
        1.0, 1.0,
        0.0, 1.0,
        1.0, 0.0,

        0.0, 1.0, // top face
        1.0, 0.0,
        1.0, 1.0,
        0.0, 0.0,

        1.0, 1.0, // bottom face
        0.0, 0.0,
        1.0, 0.0,
        0.0, 1.0,
    ];

    // The normal (x, y, z) and tangent (x, y, z, w) shared by the four vertices of each face, in
    // the order of the faces above; packed per vertex by vectorToSnorm8.
    const g_FaceNormals: number[] = [
         0.0,  0.0, -1.0, // front face
         1.0,  0.0,  0.0, // right side face
        -1.0,  0.0,  0.0, // left side face
         0.0,  0.0,  1.0, // back face
         0.0,  1.0,  0.0, // top face
         0.0, -1.0,  0.0, // bottom face
    ];

    const g_FaceTangents: number[] = [
         1.0,  0.0,  0.0, 1.0, // front face
         0.0,  0.0,  1.0, 1.0, // right side face
         0.0,  0.0, -1.0, 1.0, // left side face
        -1.0,  0.0,  0.0, 1.0, // back face
         1.0,  0.0,  0.0, 1.0, // top face
         1.0,  0.0,  0.0, 1.0, // bottom face
    ];

    const g_Indices: int[] = [
         0,  1,  2,   0,  3,  1, // front face
         4,  5,  6,   4,  7,  5, // left face
         8,  9, 10,   8, 11,  9, // right face
        12, 13, 14,  12, 15, 13, // back face
        16, 17, 18,  16, 19, 17, // top face
        20, 21, 22,  20, 23, 21, // bottom face
    ];

    // The vertex buffer, as Donut_CreateMesh lays it out (Donut's BufferGroup): the positions, the
    // texture coordinates, then the snorm8-packed normals and tangents, one stream after another.
    const POSITION_OFFSET = 0;
    const TEXCOORD_OFFSET = POSITION_OFFSET + VERTEX_COUNT * 12;
    const NORMAL_OFFSET = TEXCOORD_OFFSET + VERTEX_COUNT * 8;
    const TANGENT_OFFSET = NORMAL_OFFSET + VERTEX_COUNT * 4;
    const VERTEX_BUFFER_FLOATS = (TANGENT_OFFSET + VERTEX_COUNT * 4) / 4;

    // donut::math::vectorToSnorm8(float4(x, y, z, w)): each component scaled by 127 / |xyz|, one
    // byte each.
    function vectorToSnorm8(x: number, y: number, z: number, w: number) {
        const scale = 127.0 / Math.sqrt(x * x + y * y + z * z);
        const xi: int = Math.trunc(x * scale);
        const yi: int = Math.trunc(y * scale);
        const zi: int = Math.trunc(z * scale);
        const wi: int = Math.trunc(w * scale);
        return (xi & 0xff) | ((yi & 0xff) << 8) | ((zi & 0xff) << 16) | ((wi & 0xff) << 24);
    }

    // The vertex buffer's contents (the packed vectors stored as their bits).
    function vertexBufferData() {
        const data: f32[] = [];
        for (let i = 0; i < VERTEX_BUFFER_FLOATS; i++) {
            data.push(0.0);
        }
        for (let i = 0; i < VERTEX_COUNT * 3; i++) {
            data[POSITION_OFFSET / 4 + i] = g_Positions[i];
        }
        for (let i = 0; i < VERTEX_COUNT * 2; i++) {
            data[TEXCOORD_OFFSET / 4 + i] = g_TexCoords[i];
        }
        for (let vertex = 0; vertex < VERTEX_COUNT; vertex++) {
            const face = Math.floor(vertex / 4);
            Nri.storeInt32(Ref(data[NORMAL_OFFSET / 4 + vertex]),
                vectorToSnorm8(g_FaceNormals[face * 3], g_FaceNormals[face * 3 + 1], g_FaceNormals[face * 3 + 2], 0.0));
            Nri.storeInt32(Ref(data[TANGENT_OFFSET / 4 + vertex]),
                vectorToSnorm8(g_FaceTangents[face * 4], g_FaceTangents[face * 4 + 1], g_FaceTangents[face * 4 + 2], g_FaceTangents[face * 4 + 3]));
        }
        return data;
    }

    // The mesh's instance (donut/shaders/bindless.h's InstanceData: flags, firstGeometryInstanceIndex,
    // firstGeometryIndex, numGeometries, then float3x4 transform and prevTransform), identity
    // transforms, as Donut_CreateMesh writes it.
    const INSTANCE_DATA: f32[] = [
        0.0, 0.0, 0.0, 0.0,
        1.0, 0.0, 0.0, 0.0,  0.0, 1.0, 0.0, 0.0,  0.0, 0.0, 1.0, 0.0,
        1.0, 0.0, 0.0, 0.0,  0.0, 1.0, 0.0, 0.0,  0.0, 0.0, 1.0, 0.0,
    ];
    const INSTANCE_DATA_SIZE = 112;

    // GBufferPushConstants (donut/shaders/gbuffer_cb.h): startInstanceLocation, startVertexLocation,
    // then the streams' offsets (the previous positions are the positions: the mesh has none).
    const PUSH_CONSTANTS = [0, 0, POSITION_OFFSET, POSITION_OFFSET, TEXCOORD_OFFSET, NORMAL_OFFSET, TANGENT_OFFSET];

    // Donut's blit (CommonRenderPasses::BlitTexture) of the shaded color into the swap chain texture:
    // struct BlitConstants { float2 sourceOrigin, sourceSize, targetOrigin, targetSize;
    // float sharpenFactor; }.
    const BLIT_CONSTANTS: f32[] = [0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0];

    // The sun (Donut_AddDirectionalLight's arguments in the Donut example) and the ambient colors.
    const SUN_DIRECTION = [0.1, -1.0, 0.2];
    const SUN_ANGULAR_SIZE = 0.53;
    const SUN_IRRADIANCE = 1.0;
    const AMBIENT_TOP = 0.2;

    // The deferred lighting shader's thread groups (16 x 16).
    const LIGHTING_GROUP_SIZE = 16;

    // Constant buffer views' alignment.
    const CONSTANTS_ALIGNMENT = 256;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // --- Math ---------------------------------------------------------------------------------
    // The donut::math functions the C++ sample uses, on row-major 4x4 matrices (16 numbers) with
    // Donut's row-vector convention: `mul(a, b)` applies a, then b.

    function mul(a: number[], b: number[]) {
        const r: number[] = [];
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                let sum = 0.0;
                for (let k = 0; k < 4; k++) {
                    sum += a[i * 4 + k] * b[k * 4 + j];
                }
                r.push(sum);
            }
        }
        return r;
    }

    // math::yawPitchRoll(yaw, pitch, roll).
    function yawPitchRoll(yaw: number, pitch: number, roll: number) {
        const sh = Math.sin(yaw);
        const ch = Math.cos(yaw);
        const sp = Math.sin(pitch);
        const cp = Math.cos(pitch);
        const sb = Math.sin(roll);
        const cb = Math.cos(roll);
        return [
            ch * cb + sh * sp * sb,  sb * cp, -sh * cb + ch * sp * sb, 0.0,
            -ch * sb + sh * sp * cb, cb * cp, sb * sh + ch * sp * cb,  0.0,
            sh * cp,                 -sp,     ch * cp,                 0.0,
            0.0,                     0.0,     0.0,                     1.0,
        ];
    }

    function alignConstants(size: int) {
        return Math.floor((size + CONSTANTS_ALIGNMENT - 1) / CONSTANTS_ALIGNMENT) * CONSTANTS_ALIGNMENT;
    }

    // A frame in flight's own data: its descriptor sets (its copies of the view's and the
    // lighting's constants).
    class QueuedFrame {
        constructor(public viewSet: NriDescriptorSet | null, public lightingSet: NriDescriptorSet | null,
            public viewConstantsView: NriDescriptor | null, public lightingConstantsView: NriDescriptor | null) {
        }
    }

    // A G-buffer texture (or the depth), its attachment view and the view shaders read.
    class Target {
        constructor(public texture: NriTexture, public attachment: NriDescriptor, public view: NriDescriptor) {
        }
    }

    // Port of Donut-Samples' deferred_shading.cpp (as examples/deferred_shading.ts ports it) to NRI:
    // a textured cube turning under the sun, drawn into a G-buffer (Donut's GBufferRenderTargets:
    // sRGB diffuse and specular, snorm normals, float emissive, D24S8 depth) by Donut's G-buffer fill
    // pass's shaders (vertices loaded from buffers), lit by Donut's deferred lighting compute shader
    // into a float texture, and blitted into the swap chain.
    class DeferredShading {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        // The swap chain textures' format and the views' (sRGB).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private viewFormat: NriFormat = NriFormat.Unknown;
        // The size the swap chain and the window-size targets were made at: the window's then.
        private width: int = 0;
        private height: int = 0;

        // The G-buffer (diffuse, specular, normals, emissive), its depth, the lit result.
        private gbuffer: Target[] = [];
        private depth: Target | null = null;
        private shadedColor: NriTexture | null = null;
        private shadedColorStorage: NriDescriptor | null = null;
        private shadedColorView: NriDescriptor | null = null;
        // The states the G-buffer (and its depth) and the shaded color are in between frames.
        private gbufferState: NriTextureState = NriTextureState.ShaderResource;
        private shadedColorState: NriTextureState = NriTextureState.Storage;

        // Donut's CommonRenderPasses textures bound for what the passes aren't given: black, white,
        // a black cubemap array, a depth texture array (the shadow maps'); their views.
        private solidTextures: NriTexture[] = [];
        private shadowMapTexture: NriTexture | null = null;
        // Cleared (to 0, Donut's black) in the first frame: D3D12 wants depth textures initialized
        // before shaders read them.
        private shadowMapAttachment: NriDescriptor | null = null;
        private shadowMapCleared: boolean = false;
        private blackView: NriDescriptor | null = null;
        private whiteView: NriDescriptor | null = null;
        private shadowMapView: NriDescriptor | null = null;
        private blackCubeArrayView: NriDescriptor | null = null;

        // The mesh and its material.
        private vertexBuffer: NriBuffer | null = null;
        private vertexBufferView: NriDescriptor | null = null;
        private indexBuffer: NriBuffer | null = null;
        private instanceBuffer: NriBuffer | null = null;
        private instanceBufferView: NriDescriptor | null = null;
        private texture: NriTexture | null = null;
        private textureView: NriDescriptor | null = null;
        private materialBuffer: NriBuffer | null = null;
        private materialView: NriDescriptor | null = null;

        // Samplers: Donut's anisotropic wrap (the material's), its shadow samplers (border, and
        // comparison), linear wrap and linear clamp.
        private samplers: NriDescriptor[] = [];

        // The passes: layouts, pipelines, the per-frame constants (GBufferFillConstants and
        // DeferredLightingConstants, a queued frame's copy each) and the sets.
        private gbufferLayout: NriPipelineLayout | null = null;
        private gbufferPipeline: NriPipeline | null = null;
        private lightingLayout: NriPipelineLayout | null = null;
        private lightingPipeline: NriPipeline | null = null;
        private blitLayout: NriPipelineLayout | null = null;
        private blitPipeline: NriPipeline | null = null;
        private constantBuffer: NriBuffer | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private materialSet: NriDescriptorSet | null = null;
        private blitSet: NriDescriptorSet | null = null;
        private viewConstantsSize: int = 0;
        private viewStride: int = 0;
        private lightingStride: int = 0;

        // The sample's animation and view; constants written by C++ (upload buffers).
        private test: boolean = false;
        private rotation: number = 0.0;
        private viewMatrix: f32[] = [];
        private projMatrix: f32[] = [];
        private viewConstants: f32[] = [];
        private lightConstants: f32[] = [];
        private lightingConstants: f32[] = [];
        private pushConstants: f32[] = [];
        private blitConstants: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
            for (let i = 0; i < 16; i++) {
                this.viewMatrix.push(0.0);
                this.projMatrix.push(0.0);
            }
            for (let i = 0; i < PUSH_CONSTANTS.length; i++) {
                this.pushConstants.push(0.0);
                Nri.storeInt32(Ref(this.pushConstants[i]), PUSH_CONSTANTS[i]);
            }
            for (const value of BLIT_CONSTANTS) {
                this.blitConstants.push(value);
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

            // Swap chain: blitted into through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;

            if (!this.createTargets(device) || !this.createMesh(device, graphicsAPI) || !this.createLayouts(device)
                || !this.createPipelines(device, graphicsAPI) || !this.createDescriptorSets(device, queuedFrameNum)) {
                return 0;
            }

            // The sun's LightConstants, as Donut_AddDirectionalLight's light fills them.
            for (let i = 0; i < Nri.getDonutConstantsSize(2) / 4; i++) {
                this.lightConstants.push(0.0);
            }
            Nri.fillDonutDirectionalLightConstants(SUN_DIRECTION[0], SUN_DIRECTION[1], SUN_DIRECTION[2], SUN_ANGULAR_SIZE, SUN_IRRADIANCE,
                Ref(this.lightConstants[0]));

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

        // The window was resized (NriSample.useResizableWindow): once the GPU is done with them, the swap
        // chain and the window-size targets made again at its size, and the sets pointed at them.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (!this.swapChain.resized()) {
                return;
            }
            device.waitIdle();
            this.destroySizedTargets();
            this.swapChain.recreate();
            this.sizeToSwapChain();
            if (this.createSizedTargets(device)) {
                this.updateSizedDescriptors();
            }
        }

        // The G-buffer, its depth and the shaded color (createSizedTargets), Donut's fallback textures.
        createTargets(device: NriDevice) {
            return this.createSizedTargets(device) && this.createFallbackTextures(device);
        }

        // The window-size targets: the G-buffer (GBufferRenderTargets' formats; the depth: the first
        // of Donut's choices, D24S8) and the shaded color (RGBA16_FLOAT, written by the lighting
        // shader), in the states their creation leaves them in.
        createSizedTargets(device: NriDevice) {
            this.gbufferState = NriTextureState.ShaderResource;
            this.shadedColorState = NriTextureState.Storage;
            const formats = [NriFormat.RGBA8_SRGB, NriFormat.RGBA8_SRGB, NriFormat.RGBA16_SNORM, NriFormat.RGBA16_SFLOAT];
            for (const format of formats) {
                const texture = device.createRenderTargetTexture(this.queue, this.width, this.height, format);
                if (!texture) {
                    console.log("Cannot create the G-buffer");
                    return false;
                }
                this.gbuffer.push(new Target(texture, texture.createColorAttachmentView(format), texture.createView(format)));
            }
            const depthTexture = device.createSampledDepthTexture(this.queue, this.width, this.height, NriFormat.D24_UNORM_S8_UINT);
            if (!depthTexture) {
                console.log("Cannot create the depth buffer");
                return false;
            }
            this.depth = new Target(depthTexture, depthTexture.createDepthAttachmentView(NriFormat.D24_UNORM_S8_UINT),
                depthTexture.createView(NriFormat.R24_UNORM_X8));

            const shadedColor = device.createStorageTexture(this.queue, this.width, this.height, NriFormat.RGBA16_SFLOAT);
            this.shadedColor = shadedColor;
            if (!shadedColor) {
                console.log("Cannot create the shaded color texture");
                return false;
            }
            this.shadedColorStorage = shadedColor.createStorageView(NriFormat.RGBA16_SFLOAT);
            this.shadedColorView = shadedColor.createView(NriFormat.RGBA16_SFLOAT);
            return true;
        }

        destroySizedTargets() {
            for (const target of this.gbuffer) {
                this.destroyTarget(target);
            }
            this.gbuffer = [];
            const depth = this.depth;
            if (depth) {
                this.destroyTarget(depth);
            }
            this.depth = null;
            this.destroyDescriptor(this.shadedColorStorage);
            this.destroyDescriptor(this.shadedColorView);
            this.destroyTexture(this.shadedColor);
            this.shadedColorStorage = null;
            this.shadedColorView = null;
            this.shadedColor = null;
        }

        // Donut's CommonRenderPasses fallback textures (black, white, black cubes, the shadow map).
        createFallbackTextures(device: NriDevice) {
            const black = device.createSolidTexture(this.queue, 1, 0xFF000000, NriTextureState.AllShaderResource);
            const white = device.createSolidTexture(this.queue, 1, 0xFFFFFFFF, NriTextureState.AllShaderResource);
            const blackCubes = device.createSolidTexture(this.queue, 6, 0xFF000000, NriTextureState.AllShaderResource);
            if (!black || !white || !blackCubes) {
                console.log("Cannot create the default textures");
                return false;
            }
            this.solidTextures.push(black);
            this.solidTextures.push(white);
            this.solidTextures.push(blackCubes);
            this.blackView = black.createView(NriFormat.RGBA8_UNORM);
            this.whiteView = white.createView(NriFormat.RGBA8_UNORM);
            // (A depth format: the shader samples the shadow maps with comparisons.)
            const shadowMapTexture = device.createSampledDepthTexture(this.queue, 1, 1, NriFormat.D16_UNORM);
            this.shadowMapTexture = shadowMapTexture;
            if (!shadowMapTexture) {
                console.log("Cannot create the default textures");
                return false;
            }
            this.shadowMapView = shadowMapTexture.createArrayView(NriFormat.D16_UNORM);
            this.shadowMapAttachment = shadowMapTexture.createDepthAttachmentView(NriFormat.D16_UNORM);
            this.blackCubeArrayView = blackCubes.createCubeArrayView(NriFormat.RGBA8_UNORM);
            return true;
        }

        // The cube (Donut_CreateMesh's buffers: the vertex buffer and the instance read by the
        // vertex shader, raw on D3D11 as its shader reads them) and its material (the texture and
        // its MaterialConstants).
        createMesh(device: NriDevice, graphicsAPI: NriGraphicsAPI) {
            const vertices = vertexBufferData();
            const vertexBuffer = device.createUploadedStructuredBuffer(this.queue, Ref(vertices[0]), vertices.length * 4, 4);
            this.vertexBuffer = vertexBuffer;
            const indices = g_Indices.map((v): int => v);
            this.indexBuffer = device.createUploadedBufferFromInts(this.queue, Ref(indices[0]), indices.length * 4, NriBufferUsage.IndexBuffer);
            // D3D11's shader reads the instances as a ByteAddressBuffer, the others' as structures.
            const instanceStride = graphicsAPI == NriGraphicsAPI.D3D11 ? 4 : INSTANCE_DATA_SIZE;
            const instanceData = INSTANCE_DATA.map((v): f32 => v);
            const instanceBuffer = device.createUploadedStructuredBuffer(this.queue, Ref(instanceData[0]), INSTANCE_DATA_SIZE,
                instanceStride);
            this.instanceBuffer = instanceBuffer;
            if (!vertexBuffer || !instanceBuffer || !this.indexBuffer) {
                console.log("Cannot create the mesh");
                return false;
            }
            this.vertexBufferView = vertexBuffer.createStructuredView(0);
            this.instanceBufferView = instanceBuffer.createStructuredView(0);

            // Donut's TextureCache: mip 0 only (no CommonRenderPasses to generate the others), sRGB.
            const texture = device.loadImageTexture(this.queue, TEXTURE_PATH, 1);
            this.texture = texture;
            if (!texture) {
                console.log("Couldn't load the texture");
                return false;
            }
            this.textureView = texture.createView(NriFormat.RGBA8_SRGB);

            const materialSize = alignConstants(Nri.getDonutConstantsSize(1));
            const material: f32[] = [];
            for (let i = 0; i < materialSize / 4; i++) {
                material.push(0.0);
            }
            Nri.fillDonutTexturedMaterialConstants(1, Ref(material[0]));
            const materialBuffer = device.createHostBuffer(materialSize, NriBufferUsage.ConstantBuffer);
            this.materialBuffer = materialBuffer;
            if (!materialBuffer) {
                console.log("Cannot create the material");
                return false;
            }
            materialBuffer.write(0, Ref(material[0]), materialSize);
            this.materialView = materialBuffer.createConstantView(0, materialSize);
            return true;
        }

        // The passes' layouts, as their shaders declare their bindings (Donut's register spaces:
        // a set each, the G-buffer's inputs as root descriptors in the root register space).
        createLayouts(device: NriDevice) {
            // G-buffer fill: space 0 the material (b0, t0 to t6), space 1 the push constants (b1)
            // and the instances and vertices (t10, t11), space 2 the view (b2) and its sampler (s0).
            const gbufferDesc = NriPipelineLayoutDesc.create();
            gbufferDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Pixel, NriRangeFlags.None);
            gbufferDesc.addRange(0, 0, 7, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            gbufferDesc.addRange(1, 2, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            gbufferDesc.addRange(1, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            gbufferDesc.setRegisterSpace(1, 2);
            gbufferDesc.setRootRegisterSpace(1);
            gbufferDesc.addRootConstants(1, PUSH_CONSTANTS.length * 4, NriStage.Vertex);
            gbufferDesc.addRootDescriptor(10, NriDescriptorType.StructuredBuffer, NriStage.Vertex);
            gbufferDesc.addRootDescriptor(11, NriDescriptorType.StructuredBuffer, NriStage.Vertex);
            this.gbufferLayout = device.createPipelineLayoutFromDesc(gbufferDesc);
            gbufferDesc.destroy();

            // Deferred lighting: b0; t0 (shadow maps), t1, t2 (light probes), t3 (BRDF); t8 to t12 (the
            // G-buffer and depth); t14 to t17 (indirect light, shadows, ambient occlusion); u0; s0 to
            // s3.
            const lightingDesc = NriPipelineLayoutDesc.create();
            lightingDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Compute, NriRangeFlags.None);
            lightingDesc.addRange(0, 0, 4, NriDescriptorType.Texture, NriStage.Compute, NriRangeFlags.None);
            lightingDesc.addRange(0, 8, 5, NriDescriptorType.Texture, NriStage.Compute, NriRangeFlags.None);
            lightingDesc.addRange(0, 14, 4, NriDescriptorType.Texture, NriStage.Compute, NriRangeFlags.None);
            lightingDesc.addRange(0, 0, 1, NriDescriptorType.StorageTexture, NriStage.Compute, NriRangeFlags.None);
            lightingDesc.addRange(0, 0, 4, NriDescriptorType.Sampler, NriStage.Compute, NriRangeFlags.None);
            this.lightingLayout = device.createPipelineLayoutFromDesc(lightingDesc);
            lightingDesc.destroy();

            // Blit: its constants (b0), the source (t0) and the sampler (s0).
            const blitDesc = NriPipelineLayoutDesc.create();
            blitDesc.addRootConstants(0, BLIT_CONSTANTS.length * 4, NriStage.Vertex);
            blitDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            blitDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            this.blitLayout = device.createPipelineLayoutFromDesc(blitDesc);
            blitDesc.destroy();

            if (!this.gbufferLayout || !this.lightingLayout || !this.blitLayout) {
                console.log("Cannot create the pipeline layouts");
                return false;
            }
            return true;
        }

        // Donut's shaders, as Donut compiles them (shaders/framework): the G-buffer fill pass's
        // (buffer loads, no motion vectors or alpha test; back faces culled, depth tested less or
        // equal and written), the deferred lighting pass's and the blit's.
        createPipelines(device: NriDevice, graphicsAPI: NriGraphicsAPI) {
            const gbufferLayout = this.gbufferLayout;
            const lightingLayout = this.lightingLayout;
            const blitLayout = this.blitLayout;
            if (!gbufferLayout || !lightingLayout || !blitLayout) {
                return false;
            }
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : (graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv");
            const framework = `shaders/framework/${folder}`;

            const gbufferDesc = NriPipelineDesc.create();
            let loaded = gbufferDesc.addShaderPermutation(NriShaderStage.Vertex, `${framework}/passes/gbuffer_vs_buffer_loads.bin`,
                "buffer_loads", "MOTION_VECTORS=0") != 0;
            if (loaded) {
                loaded = gbufferDesc.addShaderPermutation(NriShaderStage.Pixel, `${framework}/passes/gbuffer_ps.bin`, "main",
                    "ALPHA_TESTED=0 MOTION_VECTORS=0") != 0;
            }
            gbufferDesc.setCullMode(NriCullMode.Back);
            gbufferDesc.setColor(this.gbuffer[0].texture.getFormat(), NriColorWrite.RGBA);
            for (let k = 1; k < this.gbuffer.length; k++) {
                gbufferDesc.addColor(this.gbuffer[k].texture.getFormat(), NriColorWrite.RGBA);
            }
            gbufferDesc.setDepth(NriFormat.D24_UNORM_S8_UINT, NriCompareOp.LessEqual, 1, 0);
            if (loaded) {
                this.gbufferPipeline = device.createPipelineFromDesc(gbufferLayout, gbufferDesc);
            }
            gbufferDesc.destroy();

            this.lightingPipeline = device.createComputePipeline(lightingLayout, `${framework}/passes/deferred_lighting_cs.bin`, "main");

            const blitDesc = NriPipelineDesc.create();
            loaded = blitDesc.addShader(NriShaderStage.Vertex, `${framework}/rect_vs.bin`, "main") != 0;
            if (loaded) {
                loaded = blitDesc.addShaderPermutation(NriShaderStage.Pixel, `${framework}/blit_ps.bin`, "main",
                    "TEXTURE_ARRAY=0") != 0;
            }
            blitDesc.setTopology(NriTopology.TriangleStrip);
            blitDesc.setColor(this.viewFormat, NriColorWrite.RGBA);
            if (loaded) {
                this.blitPipeline = device.createPipelineFromDesc(blitLayout, blitDesc);
            }
            blitDesc.destroy();

            if (!this.gbufferPipeline || !this.lightingPipeline || !this.blitPipeline) {
                console.log("Cannot load Donut's shaders");
                return false;
            }
            return true;
        }

        // The samplers, the constant buffer (a queued frame's GBufferFillConstants and
        // DeferredLightingConstants each), the queued frames and their sets, the material's and the
        // blit's set.
        createDescriptorSets(device: NriDevice, queuedFrameNum: int) {
            // CommonRenderPasses' anisotropic wrap sampler (16), DeferredLightingPass's shadow samplers
            // (border; comparison), linear wrap, linear clamp.
            this.samplers.push(device.createSampler(NriFilter.Linear, NriAddressMode.Repeat, 16));
            this.samplers.push(device.createSampler(NriFilter.Linear, NriAddressMode.ClampToBorder, 1));
            this.samplers.push(device.createComparisonSampler(NriCompareOp.Less));
            this.samplers.push(device.createSampler(NriFilter.Linear, NriAddressMode.Repeat, 1));
            this.samplers.push(device.createSampler(NriFilter.Linear, NriAddressMode.ClampToEdge, 1));

            this.viewConstantsSize = Nri.getDonutConstantsSize(0);
            for (let i = 0; i < this.viewConstantsSize / 4; i++) {
                this.viewConstants.push(0.0);
            }
            const lightingConstantsSize = Nri.getDonutConstantsSize(3);
            for (let i = 0; i < lightingConstantsSize / 4; i++) {
                this.lightingConstants.push(0.0);
            }
            this.viewStride = alignConstants(this.viewConstantsSize * 2);
            this.lightingStride = alignConstants(lightingConstantsSize);
            const frameStride = this.viewStride + this.lightingStride;
            const constantBuffer = device.createHostBuffer(queuedFrameNum * frameStride, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;

            // A queued frame's view and lighting sets; the material's and the blit's.
            const setNum = 2 * queuedFrameNum + 2;
            const descriptorPool = device.createDescriptorPool(setNum, 5 * queuedFrameNum + 1, 2 * queuedFrameNum + 1,
                13 * queuedFrameNum + 8, queuedFrameNum, 0);
            this.descriptorPool = descriptorPool;
            const gbufferLayout = this.gbufferLayout;
            const lightingLayout = this.lightingLayout;
            const blitLayout = this.blitLayout;
            const depth = this.depth;
            const textureView = this.textureView;
            const materialView = this.materialView;
            const blackView = this.blackView;
            const whiteView = this.whiteView;
            const shadowMapView = this.shadowMapView;
            const blackCubeArrayView = this.blackCubeArrayView;
            const shadedColorStorage = this.shadedColorStorage;
            const shadedColorView = this.shadedColorView;
            if (!constantBuffer || !descriptorPool || !gbufferLayout || !lightingLayout || !blitLayout || !depth) {
                console.log("Cannot create the descriptors");
                return false;
            }
            if (!textureView || !materialView || !blackView || !whiteView || !shadowMapView || !blackCubeArrayView
                || !shadedColorStorage || !shadedColorView) {
                console.log("Cannot create the descriptors");
                return false;
            }

            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const viewSet = descriptorPool.allocateDescriptorSet(gbufferLayout, 1, 0);
                const lightingSet = descriptorPool.allocateDescriptorSet(lightingLayout, 0, 0);
                const viewConstantsView = constantBuffer.createConstantView(i * frameStride, this.viewStride);
                const lightingConstantsView = constantBuffer.createConstantView(i * frameStride + this.viewStride,
                    this.lightingStride);
                this.queuedFrames.push(new QueuedFrame(viewSet, lightingSet,
                    viewConstantsView, lightingConstantsView));
                if (!viewSet || !lightingSet || !viewConstantsView || !lightingConstantsView) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                viewSet.updateDescriptor(0, 0, viewConstantsView);
                viewSet.updateDescriptor(1, 0, this.samplers[0]);

                // DeferredLightingPass's bindings, CommonRenderPasses' textures for those it isn't given.
                lightingSet.updateDescriptor(0, 0, lightingConstantsView);
                lightingSet.updateDescriptor(1, 0, shadowMapView);
                lightingSet.updateDescriptor(1, 1, blackCubeArrayView);
                lightingSet.updateDescriptor(1, 2, blackCubeArrayView);
                lightingSet.updateDescriptor(1, 3, blackView);
                lightingSet.updateDescriptor(3, 0, blackView);
                lightingSet.updateDescriptor(3, 1, blackView);
                lightingSet.updateDescriptor(3, 2, blackView);
                lightingSet.updateDescriptor(3, 3, whiteView);
                for (let k = 0; k < 4; k++) {
                    lightingSet.updateDescriptor(5, k, this.samplers[1 + k]);
                }
            }

            // The material: its constants, its texture, black for the others.
            const materialSet = descriptorPool.allocateDescriptorSet(gbufferLayout, 0, 0);
            this.materialSet = materialSet;
            const blitSet = descriptorPool.allocateDescriptorSet(blitLayout, 0, 0);
            this.blitSet = blitSet;
            if (!materialSet || !blitSet) {
                console.log("Cannot create the descriptor sets");
                return false;
            }
            materialSet.updateDescriptor(0, 0, materialView);
            materialSet.updateDescriptor(1, 0, textureView);
            for (let k = 1; k < 7; k++) {
                materialSet.updateDescriptor(1, k, blackView);
            }
            blitSet.updateDescriptor(1, 0, this.samplers[4]);
            this.updateSizedDescriptors();
            return true;
        }

        // The window-size targets' views in the sets: each queued frame's lighting set (the depth,
        // the G-buffer, the shaded color written) and the blit's (the shaded color read).
        updateSizedDescriptors() {
            const depth = this.depth;
            const shadedColorStorage = this.shadedColorStorage;
            const shadedColorView = this.shadedColorView;
            const blitSet = this.blitSet;
            if (!depth || !shadedColorStorage || !shadedColorView || !blitSet) {
                return;
            }
            for (const queuedFrame of this.queuedFrames) {
                const lightingSet = queuedFrame.lightingSet;
                if (lightingSet) {
                    lightingSet.updateDescriptor(2, 0, depth.view);
                    for (let k = 0; k < this.gbuffer.length; k++) {
                        lightingSet.updateDescriptor(2, 1 + k, this.gbuffer[k].view);
                    }
                    lightingSet.updateDescriptor(4, 0, shadedColorStorage);
                }
            }
            blitSet.updateDescriptor(0, 0, shadedColorView);
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The sample's Animate (the cube turns 1.1 radians a second; Donut's test mode passes a
        // float 1/60 s a frame), then its view: the camera 2 behind the cube, looking 30 degrees
        // down, and a 60 degree projection from 0.1 to 10.
        animate() {
            this.rotation += (this.test ? Math.fround(1.0 / 60.0) : this.sample.getFrameTime()) * 1.1;

            const viewMatrix = mul(mul(
                yawPitchRoll(this.rotation, 0.0, 0.0),
                yawPitchRoll(0.0, radiansF32(-30.0), 0.0)),
                translation(0.0, 0.0, 2.0));
            const projection = perspProjD3DStyle(radiansF32(60.0), this.width / this.height, 0.1, 10.0);
            for (let i = 0; i < 16; i++) {
                this.viewMatrix[i] = viewMatrix[i];
                this.projMatrix[i] = projection[i];
            }
        }

        // The queued frame's GBufferFillConstants (the view, and as the previous view the same) and
        // DeferredLightingConstants (the view, the sun, the ambient colors).
        writeConstants(queuedFrameIndex: int) {
            const constantBuffer = this.constantBuffer;
            if (!constantBuffer) {
                return;
            }
            const offset = queuedFrameIndex * (this.viewStride + this.lightingStride);
            Nri.fillDonutPlanarViewConstants(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), this.width, this.height,
                Ref(this.viewConstants[0]));
            constantBuffer.write(offset, Ref(this.viewConstants[0]), this.viewConstantsSize);
            constantBuffer.write(offset + this.viewConstantsSize, Ref(this.viewConstants[0]), this.viewConstantsSize);

            Nri.fillDonutDeferredLightingConstants(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), this.width, this.height,
                Ref(this.lightConstants[0]), 1, AMBIENT_TOP, AMBIENT_TOP, AMBIENT_TOP,
                AMBIENT_TOP * 0.3, AMBIENT_TOP * 0.4, AMBIENT_TOP * 0.3, Ref(this.lightingConstants[0]));
            constantBuffer.write(offset + this.viewStride, Ref(this.lightingConstants[0]), this.lightingConstants.length * 4);
        }

        // The shadow map texture, cleared once.
        clearShadowMap(commandBuffer: NriCommandBuffer) {
            const texture = this.shadowMapTexture;
            const attachment = this.shadowMapAttachment;
            if (this.shadowMapCleared || !texture || !attachment) {
                return;
            }
            commandBuffer.textureBarrier(texture, NriTextureState.ShaderResource, NriTextureState.DepthAttachment);
            commandBuffer.beginRenderingDepthOnly(attachment);
            commandBuffer.clearDepth(0.0);
            commandBuffer.endRendering();
            commandBuffer.textureBarrier(texture, NriTextureState.DepthAttachment, NriTextureState.ShaderResource);
            this.shadowMapCleared = true;
        }

        // The G-buffer, cleared (to 0, the depth to 1), then the cube drawn into it, as Donut's
        // GBufferFillPass draws it.
        recordGBuffer(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const depth = this.depth;
            const layout = this.gbufferLayout;
            const pipeline = this.gbufferPipeline;
            const descriptorPool = this.descriptorPool;
            const materialSet = this.materialSet;
            const viewSet = queuedFrame.viewSet;
            const indexBuffer = this.indexBuffer;
            const instanceBufferView = this.instanceBufferView;
            const vertexBufferView = this.vertexBufferView;
            if (!depth || !layout || !pipeline || !descriptorPool || !materialSet || !viewSet || !indexBuffer) {
                return;
            }
            if (!instanceBufferView || !vertexBufferView) {
                return;
            }
            for (const target of this.gbuffer) {
                commandBuffer.textureBarrier(target.texture, this.gbufferState, NriTextureState.ColorAttachment);
            }
            commandBuffer.textureBarrier(depth.texture, this.gbufferState, NriTextureState.DepthAttachment);

            commandBuffer.beginRenderingWithFourColorsAndDepth(this.gbuffer[0].attachment, this.gbuffer[1].attachment,
                this.gbuffer[2].attachment, this.gbuffer[3].attachment, depth.attachment);
            for (let k = 0; k < this.gbuffer.length; k++) {
                commandBuffer.clearColorAttachment(k, 0.0, 0.0, 0.0, 0.0);
            }
            commandBuffer.clearDepth(1.0);
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(layout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setDescriptorSet(0, materialSet);
            commandBuffer.setDescriptorSet(1, viewSet);
            commandBuffer.setRootConstants(0, Ref(this.pushConstants[0]), PUSH_CONSTANTS.length * 4);
            commandBuffer.setRootDescriptor(0, instanceBufferView, 0);
            commandBuffer.setRootDescriptor(1, vertexBufferView, 0);
            commandBuffer.setIndexBuffer(indexBuffer, 0, NriIndexType.UInt32);
            commandBuffer.drawIndexed(INDEX_COUNT, 1, 0, 0, 0);
            commandBuffer.endRendering();
        }

        // The G-buffer lit by Donut's deferred lighting shader into the shaded color.
        recordLighting(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const depth = this.depth;
            const shadedColor = this.shadedColor;
            const layout = this.lightingLayout;
            const pipeline = this.lightingPipeline;
            const lightingSet = queuedFrame.lightingSet;
            if (!depth || !shadedColor || !layout || !pipeline || !lightingSet) {
                return;
            }
            for (const target of this.gbuffer) {
                commandBuffer.textureBarrier(target.texture, NriTextureState.ColorAttachment, NriTextureState.ComputeShaderResource);
            }
            commandBuffer.textureBarrier(depth.texture, NriTextureState.DepthAttachment, NriTextureState.ComputeShaderResource);
            this.gbufferState = NriTextureState.ComputeShaderResource;
            commandBuffer.textureBarrier(shadedColor, this.shadedColorState, NriTextureState.Storage);

            commandBuffer.setComputePipelineLayout(layout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setComputeDescriptorSet(0, lightingSet);
            commandBuffer.dispatch(Math.floor((this.width + LIGHTING_GROUP_SIZE - 1) / LIGHTING_GROUP_SIZE),
                Math.floor((this.height + LIGHTING_GROUP_SIZE - 1) / LIGHTING_GROUP_SIZE), 1);

            commandBuffer.textureBarrier(shadedColor, NriTextureState.Storage, NriTextureState.ShaderResource);
            this.shadedColorState = NriTextureState.ShaderResource;
        }

        // The shaded color over the whole swap chain texture (between NriCommandBuffer.beginRendering and
        // NriCommandBuffer.endRendering), as Donut's BlitTexture draws it.
        recordBlit(commandBuffer: NriCommandBuffer) {
            const layout = this.blitLayout;
            const pipeline = this.blitPipeline;
            const blitSet = this.blitSet;
            if (!layout || !pipeline || !blitSet) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(layout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setRootConstants(0, Ref(this.blitConstants[0]), BLIT_CONSTANTS.length * 4);
            commandBuffer.setDescriptorSet(0, blitSet);
            commandBuffer.draw(4, 1, 0, 0);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            this.animate();
            this.writeConstants(queuedFrameIndex);

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: the G-buffer, its lighting, the blit.
                commandBuffer.begin();
                this.clearShadowMap(commandBuffer);
                this.recordGBuffer(commandBuffer, queuedFrame);
                this.recordLighting(commandBuffer, queuedFrame);
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                this.recordBlit(commandBuffer);
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
                for (const queuedFrame of this.queuedFrames) {
                    this.destroyDescriptor(queuedFrame.viewConstantsView);
                    this.destroyDescriptor(queuedFrame.lightingConstantsView);
                }
                this.swapChain.destroy();
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                for (const sampler of this.samplers) {
                    this.destroyDescriptor(sampler);
                }
                this.destroySizedTargets();
                this.destroyDescriptor(this.blackView);
                this.destroyDescriptor(this.whiteView);
                this.destroyDescriptor(this.shadowMapView);
                this.destroyDescriptor(this.blackCubeArrayView);
                for (const texture of this.solidTextures) {
                    texture.destroy();
                }
                this.destroyDescriptor(this.shadowMapAttachment);
                this.destroyTexture(this.shadowMapTexture);
                this.destroyDescriptor(this.vertexBufferView);
                this.destroyDescriptor(this.instanceBufferView);
                this.destroyDescriptor(this.textureView);
                this.destroyDescriptor(this.materialView);
                this.destroyTexture(this.texture);
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.indexBuffer);
                this.destroyBuffer(this.instanceBuffer);
                this.destroyBuffer(this.materialBuffer);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.gbufferPipeline);
                this.destroyPipeline(this.lightingPipeline);
                this.destroyPipeline(this.blitPipeline);
                this.destroyLayout(this.gbufferLayout);
                this.destroyLayout(this.lightingLayout);
                this.destroyLayout(this.blitLayout);
                this.frames.destroy();
                device.destroy();
            }
            this.sample.destroy();
        }

        destroyTarget(target: Target) {
            target.attachment.destroy();
            target.view.destroy();
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

        destroyLayout(layout: NriPipelineLayout | null) {
            if (layout) {
                layout.destroy();
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        return new DeferredShading(sample).run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return DeferredShadingNri.main(argc, argv);
}

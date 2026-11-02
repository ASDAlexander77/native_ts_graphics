/// <reference path="../../core/nri/nri_interop.d.ts" />
import {
    cross3, matrixLookAtRH, matrixPerspectiveFovRH, matrixRotationAxis, matrixRotationY, matrixTranspose,
    normalize3, transform4, transformCoord3, vsub, XM_PI,
} from "../../core/directx_math";
import {
    SQUID_ROOM_DRAW_FIELDS, SQUID_ROOM_DRAWS, SQUID_ROOM_INDEX_DATA_OFFSET, SQUID_ROOM_INDEX_DATA_SIZE,
    SQUID_ROOM_TEXTURE_FIELDS, SQUID_ROOM_TEXTURES, SQUID_ROOM_VERTEX_DATA_OFFSET, SQUID_ROOM_VERTEX_DATA_SIZE,
    SQUID_ROOM_VERTEX_STRIDE,
} from "../../core/squid_room";
import { DonutBlit } from "../../core/nri_donut_blit";

namespace MultithreadingNri {
    // multithreading (DirectX-Graphics-Samples' D3D12Multithreading, as examples/multithreading.ts
    // ports it), rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut and
    // NVRHI: its shaders (shaders/multithreading.hlsl), the draws recorded on worker threads by
    // nri_interop's draw passes (C++ threads: tslang code mustn't run on threads its garbage collector
    // doesn't know about), through the NRI calls core/nri/nri_interop.d.ts binds.

    const WINDOW_TITLE = "NRI Example: D3D12 Multithreading Sample";
    const DATA_FILE = "media/multithreading/SquidRoom.bin";

    // The sample's worker threads ("contexts"), each recording every third draw of both passes,
    // and its lights (keep in sync with multithreading.hlsl).
    const NUM_CONTEXTS = 3;
    const NUM_LIGHTS = 3;

    // The sample's viewport, shadow map and depth buffer: 1280 x 720 (the shader's PCF assumes the
    // shadow map's size), whatever the window's size; the frame is stretched over the window.
    const WIDTH = 1280;
    const HEIGHT = 720;

    // SceneConstantBuffer: model, view and projection matrices (transposed), the ambient color, a
    // bool (whether to sample the shadow map) padded to 16 bytes, then per light its position,
    // direction, color and falloff (float4s) and view and projection matrices (transposed): 800
    // bytes, in a 1024-byte buffer.
    const CONSTANTS_FLOATS = 256;
    const CONSTANTS_LIGHTS = 56;
    const LIGHT_FLOATS = 48;
    const CONSTANTS_SIZE = CONSTANTS_FLOATS * 4;

    // Test mode: the frames rendered, each 1/60 s.
    const TEST_FRAMES = 60;

    // GLFW's arrow key codes (Nri_IsKeyPressed's).
    const KEY_RIGHT = 262;
    const KEY_LEFT = 263;
    const KEY_DOWN = 264;
    const KEY_UP = 265;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // The sample's Camera: an eye orbiting a point, turned by the arrow keys.
    class Camera {
        eye: number[];
        at: number[];
        up: number[];

        constructor() {
            this.eye = [0.0, 15.0, -30.0, 0.0];
            this.at = [0.0, 8.0, 0.0, 0.0];
            this.up = [0.0, 1.0, 0.0, 0.0];
        }

        set(eye: number[], at: number[], up: number[]) {
            this.eye = eye;
            this.at = at;
            this.up = up;
        }

        // The view and projection matrices for a fovInDegrees vertical field of view, transposed
        // (as the constant buffer takes them).
        viewMatrix() {
            return matrixTranspose(matrixLookAtRH(this.eye, this.at, this.up));
        }

        projectionMatrix(fovInDegrees: number, screenWidth: number, screenHeight: number) {
            const aspectRatio = Math.fround(Math.fround(screenWidth) / Math.fround(screenHeight));
            let fovAngleY = Math.fround(Math.fround(Math.fround(fovInDegrees) * XM_PI) / 180.0);
            if (aspectRatio < 1.0) {
                fovAngleY = Math.fround(fovAngleY / aspectRatio);
            }
            return matrixTranspose(matrixPerspectiveFovRH(fovAngleY, aspectRatio, Math.fround(0.01), 125.0));
        }

        rotateYaw(angle: number) {
            this.eye = transformCoord3(this.eye, matrixRotationAxis(this.up, angle));
        }

        rotatePitch(angle: number) {
            const right = normalize3(cross3(this.eye, this.up));
            this.eye = transformCoord3(this.eye, matrixRotationAxis(right, angle));
        }
    }

    // A spotlight (the sample's LightState): position, direction, color, falloff (distances and
    // cosines where it fades out), and the view and projection of its camera (transposed).
    class Light {
        position: number[];
        direction: number[];
        color: number[];
        falloff: number[];
        view: number[];
        projection: number[];

        constructor() {
            this.position = [0.0, 15.0, -30.0, 1.0];
            this.direction = [0.0, 0.0, 1.0, 0.0];
            this.falloff = [800.0, 1.0, 0.0, 1.0];
            this.color = [Math.fround(0.7), Math.fround(0.7), Math.fround(0.7), 1.0];
            this.view = [];
            this.projection = [];
            for (let k = 0; k < 16; k++) {
                this.view.push(0.0);
                this.projection.push(0.0);
            }
        }
    }

    // -test: checks the last frame: the room, textured and lit (ambient light alone leaves it dark:
    // a mean brightness around 25), fills it, as the Donut example checks it.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        let sum: number = 0;
        let lit = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i];
            const v = ((p & 0xFF) + ((p >> 8) & 0xFF) + ((p >> 16) & 0xFF)) / 3;
            sum += v;
            if (v > 64) {
                lit++;
            }
        }
        const mean = sum / (width * height);
        const litFraction = lit / (width * height);
        console.log(`Mean ${mean}, lit fraction ${litFraction}`);
        if (mean < 40 || mean > 110) {
            return `mean brightness ${mean} is not in [40, 110]`;
        }
        if (litFraction < 0.3) {
            return `only ${litFraction} of the pixels are lit`;
        }
        return "";
    }

    // An f32 array of n zeros.
    function zeros(n: int) {
        const values: f32[] = [];
        for (let i = 0; i < n; i++) {
            values.push(0.0);
        }
        return values;
    }

    // What a frame in flight records into: the main thread's command buffers (the sample's "pre" one
    // with the clears, one between the passes moving the shadow map to be read, the last one with the
    // blit and the present), the workers' (a shadow pass and a scene pass each, with allocators of
    // their own), and its sets (its copies of the constants).
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public preCommandBuffer: NriCommandBufferHandle,
            public midCommandBuffer: NriCommandBufferHandle, public postCommandBuffer: NriCommandBufferHandle,
            public workerAllocators: NriCommandAllocatorHandle[], public shadowCommandBuffers: NriCommandBufferHandle[],
            public sceneCommandBuffers: NriCommandBufferHandle[], public sceneSet: NriDescriptorSetHandle,
            public shadowSet: NriDescriptorSetHandle) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // Port of DirectX-Graphics-Samples' D3D12Multithreading (as examples/multithreading.ts ports it)
    // to NRI: the SquidRoom scene (1025 draws) lit by three spotlights circling it, the first casting
    // a shadow (a shadow pass from it, then 2 x 2 PCF), each frame's draws recorded by three worker
    // threads, each into a shadow pass command buffer and a scene pass command buffer of its own
    // (nri_interop's draw passes: draw lists made at load time, replayed by C++ threads); the main
    // thread meanwhile writes the constants and records the clears. Everything runs in the sample's
    // order: clears, shadow passes, scene passes. Its R8G8B8A8_UNORM color and D32 depth buffers are
    // textures, the color blitted into the UNORM swap chain texture, as the Donut example's. Arrow
    // keys turn the camera, Space pauses the lights.
    class Multithreading {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format (createSwapChain's).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private test: boolean = false;
        // -singleThreaded: the draws recorded one context after another on the main thread (the
        // sample's SINGLETHREADED).
        singleThreaded: boolean = false;

        // The mesh, the textures (by the sample's index), the targets.
        private vertexBuffer: NriBufferHandle | null = null;
        private indexBuffer: NriBufferHandle | null = null;
        private textures: NriTextureHandle[] = [];
        private textureViews: NriDescriptorHandle[] = [];
        private colorBuffer: NriTextureHandle | null = null;
        private colorAttachment: NriDescriptorHandle | null = null;
        private colorView: NriDescriptorHandle | null = null;
        private depthBuffer: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private shadowMap: NriTextureHandle | null = null;
        private shadowAttachment: NriDescriptorHandle | null = null;
        private shadowView: NriDescriptorHandle | null = null;

        // The layouts (the scene pass: set 0 the pass's constants, the shadow map and the samplers,
        // set 1 (register space 1) a draw's diffuse and normal maps; the shadow pass: its constants),
        // the pipelines, the samplers (linear wrapping for the textures, point clamped for the shadow
        // map), the blit.
        private sceneLayout: NriPipelineLayoutHandle | null = null;
        private shadowLayout: NriPipelineLayoutHandle | null = null;
        private scenePipeline: NriPipelineHandle | null = null;
        private shadowPipeline: NriPipelineHandle | null = null;
        private wrapSampler: NriDescriptorHandle | null = null;
        private clampSampler: NriDescriptorHandle | null = null;
        private blit: DonutBlit = new DonutBlit();

        // The constant buffer: a queued frame's scene and shadow constants.
        private constantBuffer: NriBufferHandle | null = null;
        private constantViews: NriDescriptorHandle[] = [];
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        // The materials' sets by diffuse texture (made as draws need them), the blit's.
        private materialSets: NriDescriptorSetHandle[] = [];
        private blitSet: NriDescriptorSetHandle | null = null;

        // The contexts' draw lists (every third draw) and passes: shadow and scene.
        private shadowLists: NriDrawListHandle[] = [];
        private sceneLists: NriDrawListHandle[] = [];
        private shadowPasses: NriDrawPassHandle[] = [];
        private scenePasses: NriDrawPassHandle[] = [];

        private sceneConstants: f32[] = zeros(CONSTANTS_FLOATS);
        private shadowConstants: f32[] = zeros(CONSTANTS_FLOATS);
        private camera: Camera = new Camera();
        private lights: Light[] = [];
        private lightCameras: Camera[] = [];
        private animate: boolean = true;

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < NUM_LIGHTS; i++) {
                const light = new Light();
                this.lights.push(light);
                const lightCamera = new Camera();
                const eye = light.position;
                const at = [eye[0] + light.direction[0], eye[1] + light.direction[1], eye[2] + light.direction[2], eye[3] + light.direction[3]];
                lightCamera.set(eye, at, [0.0, 1.0, 0.0, 0.0]);
                this.lightCameras.push(lightCamera);
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
            this.test = Nri_IsTest(this.sample) != 0;
            Nri_SetWindowTitle(this.sample, `${WINDOW_TITLE} ${this.singleThreaded ? "(single-threaded)" : "(3 threads)"}`);

            // Swap chain: the UNORM textures blitted into as they are (the Donut example's UNORM back
            // buffers, the sample's R8G8B8A8_UNORM).
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.createSwapChain(device);
            const format = this.swapChainFormat;

            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : (graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv");
            if (!this.createTargets(device) || !this.createLayouts(device) || !this.createPipelines(device, folder)
                || !this.blit.init(device, folder, format) || !this.loadAssets(device, queuedFrameNum)) {
                return 0;
            }

            if (this.test) {
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The color buffer (RGBA8_UNORM), the depth buffer and the shadow map (D32).
        createTargets(device: NriDeviceHandle) {
            const colorBuffer = Nri_CreateRenderTargetTexture(device, this.queue, WIDTH, HEIGHT, NriFormat.RGBA8_UNORM);
            this.colorBuffer = colorBuffer;
            const depthBuffer = Nri_CreateDepthTexture(device, this.queue, WIDTH, HEIGHT, NriFormat.D32_SFLOAT);
            this.depthBuffer = depthBuffer;
            const shadowMap = Nri_CreateSampledDepthTexture(device, this.queue, WIDTH, HEIGHT, NriFormat.D32_SFLOAT);
            this.shadowMap = shadowMap;
            if (!colorBuffer || !depthBuffer || !shadowMap) {
                console.log("Cannot create the render targets");
                return false;
            }
            this.colorAttachment = Nri_CreateColorAttachmentView(colorBuffer, NriFormat.RGBA8_UNORM);
            this.colorView = Nri_CreateTextureView(colorBuffer, NriFormat.RGBA8_UNORM);
            this.depthAttachment = Nri_CreateDepthAttachmentView(depthBuffer, NriFormat.D32_SFLOAT);
            this.shadowAttachment = Nri_CreateDepthAttachmentView(shadowMap, NriFormat.D32_SFLOAT);
            this.shadowView = Nri_CreateTextureView(shadowMap, NriFormat.D32_SFLOAT);
            return true;
        }

        // The sample's root signature: the pass's constant buffer, the shadow map and the samplers
        // (register space 0), and the draw's diffuse and normal maps (space 1). The shadow pass reads its
        // constant buffer only.
        createLayouts(device: NriDeviceHandle) {
            const sceneDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(sceneDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(sceneDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(sceneDesc, 0, 0, 2, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(sceneDesc, 1, 1, 2, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescSetRegisterSpace(sceneDesc, 1, 1);
            this.sceneLayout = Nri_CreatePipelineLayoutFromDesc(device, sceneDesc);
            Nri_DestroyPipelineLayoutDesc(sceneDesc);

            const shadowDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(shadowDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Vertex, NriRangeFlags.None);
            this.shadowLayout = Nri_CreatePipelineLayoutFromDesc(device, shadowDesc);
            Nri_DestroyPipelineLayoutDesc(shadowDesc);

            if (!this.sceneLayout || !this.shadowLayout) {
                console.log("Cannot create the pipeline layouts");
                return false;
            }
            return true;
        }

        // The sample's pipeline states: back faces culled, depth tested (less or equal) and written,
        // clipped at the near and far planes (D3D12's default); the shadow pass's without a pixel
        // shader. The sample's 44-byte vertices: position, normal, texture coordinates, tangent; the
        // shadow pass reads the positions only.
        createPipelines(device: NriDeviceHandle, folder: string) {
            const sceneLayout = this.sceneLayout;
            const shadowLayout = this.shadowLayout;
            if (!sceneLayout || !shadowLayout) {
                return false;
            }
            const shaders = `shaders/multithreading/${folder}`;
            const sceneDesc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(sceneDesc, NriShaderStage.Vertex, `${shaders}/multithreading_VSMain.bin`, "VSMain") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(sceneDesc, NriShaderStage.Pixel, `${shaders}/multithreading_PSMain.bin`, "PSMain") != 0;
            }
            Nri_PipelineDescAddVertexAttribute(sceneDesc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescAddVertexAttribute(sceneDesc, "NORMAL", NriFormat.RGB32_SFLOAT, 12);
            Nri_PipelineDescAddVertexAttribute(sceneDesc, "TEXCOORD", NriFormat.RG32_SFLOAT, 24);
            Nri_PipelineDescAddVertexAttribute(sceneDesc, "TANGENT", NriFormat.RGB32_SFLOAT, 32);
            Nri_PipelineDescSetCullMode(sceneDesc, NriCullMode.Back);
            Nri_PipelineDescSetColor(sceneDesc, NriFormat.RGBA8_UNORM, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(sceneDesc, NriFormat.D32_SFLOAT, NriCompareOp.LessEqual, 1, 0);
            Nri_PipelineDescSetDepthClip(sceneDesc, 1);
            this.scenePipeline = loaded ? Nri_CreatePipelineFromDesc(device, sceneLayout, sceneDesc) : null;
            Nri_DestroyPipelineDesc(sceneDesc);

            const shadowDesc = Nri_CreatePipelineDesc();
            loaded = Nri_PipelineDescAddShader(shadowDesc, NriShaderStage.Vertex, `${shaders}/multithreading_VSShadow.bin`, "VSShadow") != 0;
            Nri_PipelineDescAddVertexAttribute(shadowDesc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescSetCullMode(shadowDesc, NriCullMode.Back);
            Nri_PipelineDescSetDepth(shadowDesc, NriFormat.D32_SFLOAT, NriCompareOp.LessEqual, 1, 0);
            Nri_PipelineDescSetDepthClip(shadowDesc, 1);
            this.shadowPipeline = loaded ? Nri_CreatePipelineFromDesc(device, shadowLayout, shadowDesc) : null;
            Nri_DestroyPipelineDesc(shadowDesc);

            if (!this.scenePipeline || !this.shadowPipeline) {
                console.log("Cannot load the multithreading shaders");
                return false;
            }
            return true;
        }

        // LoadAssets: the mesh and the textures from the data file; the samplers, the constant buffer,
        // the queued frames' sets and command buffers; the materials' sets (a set per diffuse texture:
        // the sample's descriptor table of the diffuse texture and the one after it as the normal map)
        // and the contexts' draw lists and passes.
        loadAssets(device: NriDeviceHandle, queuedFrameNum: int) {
            const file = Nri_LoadFile(DATA_FILE);
            if (!file) {
                console.log(`Cannot load ${DATA_FILE} (the sample's data: build with DIRECTX_GRAPHICS_SAMPLES_DIR set)`);
                return false;
            }
            const vertexBuffer = Nri_CreateUploadedBufferFromFile(device, this.queue, file, SQUID_ROOM_VERTEX_DATA_OFFSET,
                SQUID_ROOM_VERTEX_DATA_SIZE, NriBufferUsage.VertexBuffer);
            const indexBuffer = Nri_CreateUploadedBufferFromFile(device, this.queue, file, SQUID_ROOM_INDEX_DATA_OFFSET,
                SQUID_ROOM_INDEX_DATA_SIZE, NriBufferUsage.IndexBuffer);
            this.vertexBuffer = vertexBuffer;
            this.indexBuffer = indexBuffer;
            const textureCount: int = Math.floor(SQUID_ROOM_TEXTURES.length / SQUID_ROOM_TEXTURE_FIELDS);
            let uploaded = true;
            for (let i = 0; i < textureCount; i++) {
                const t = i * SQUID_ROOM_TEXTURE_FIELDS;
                const format = SQUID_ROOM_TEXTURES[t + 2] == 0 ? NriFormat.BC1_RGBA_UNORM : NriFormat.RGBA8_UNORM;
                const texture = Nri_CreateCommittedTexture(device, SQUID_ROOM_TEXTURES[t], SQUID_ROOM_TEXTURES[t + 1], format);
                if (!texture) {
                    uploaded = false;
                    break;
                }
                this.textures.push(texture);
                if (Nri_UploadTextureFromFile(this.queue, texture, file, SQUID_ROOM_TEXTURES[t + 3], SQUID_ROOM_TEXTURES[t + 4]) == 0) {
                    uploaded = false;
                    break;
                }
                this.textureViews.push(Nri_CreateTextureView(texture, format));
            }
            Nri_DestroyFile(file);
            if (!vertexBuffer || !indexBuffer || !uploaded) {
                console.log(`Cannot create the room from ${DATA_FILE}`);
                return false;
            }

            const sceneLayout = this.sceneLayout;
            const shadowLayout = this.shadowLayout;
            const scenePipeline = this.scenePipeline;
            const shadowPipeline = this.shadowPipeline;
            const colorAttachment = this.colorAttachment;
            const depthAttachment = this.depthAttachment;
            const shadowAttachment = this.shadowAttachment;
            const shadowView = this.shadowView;
            const colorView = this.colorView;
            if (!sceneLayout || !shadowLayout || !scenePipeline || !shadowPipeline || !colorAttachment || !depthAttachment) {
                return false;
            }
            if (!shadowAttachment || !shadowView || !colorView) {
                return false;
            }

            // The sample's samplers: linear and wrapping for the textures, point and clamped for the
            // shadow map.
            const wrapSampler = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.Repeat, 1);
            const clampSampler = Nri_CreateSampler(device, NriFilter.Nearest, NriAddressMode.ClampToEdge, 1);
            this.wrapSampler = wrapSampler;
            this.clampSampler = clampSampler;
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * 2 * CONSTANTS_SIZE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const descriptorPool = Nri_CreateDescriptorPool(device, 2 * queuedFrameNum + textureCount + 1,
                2 * queuedFrameNum + 1, 2 * queuedFrameNum, queuedFrameNum + 2 * textureCount + 1, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!wrapSampler || !clampSampler || !constantBuffer || !descriptorPool) {
                console.log("Cannot create the descriptors");
                return false;
            }

            // A queued frame's: its sets (the scene pass's constants, shadow map and samplers; the shadow
            // pass's constants) and command buffers.
            for (let i = 0; i < queuedFrameNum; i++) {
                const sceneSet = Nri_AllocateDescriptorSet(descriptorPool, sceneLayout, 0, 0);
                const shadowSet = Nri_AllocateDescriptorSet(descriptorPool, shadowLayout, 0, 0);
                const sceneView = Nri_CreateConstantBufferView(constantBuffer, this.sceneOffset(i), CONSTANTS_SIZE);
                const shadowConstantsView = Nri_CreateConstantBufferView(constantBuffer, this.shadowOffset(i), CONSTANTS_SIZE);
                if (!sceneSet || !shadowSet || !sceneView || !shadowConstantsView) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                this.constantViews.push(sceneView);
                this.constantViews.push(shadowConstantsView);
                Nri_UpdateDescriptor(sceneSet, 0, 0, sceneView);
                Nri_UpdateDescriptor(sceneSet, 1, 0, shadowView);
                Nri_UpdateDescriptor(sceneSet, 2, 0, wrapSampler);
                Nri_UpdateDescriptor(sceneSet, 2, 1, clampSampler);
                Nri_UpdateDescriptor(shadowSet, 0, 0, shadowConstantsView);

                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const workerAllocators: NriCommandAllocatorHandle[] = [];
                const shadowCommandBuffers: NriCommandBufferHandle[] = [];
                const sceneCommandBuffers: NriCommandBufferHandle[] = [];
                for (let c = 0; c < NUM_CONTEXTS; c++) {
                    // Each pass records on a thread of its own, at the same time as the others: an
                    // allocator each.
                    const shadowAllocator = Nri_CreateCommandAllocator(this.queue);
                    const sceneAllocator = Nri_CreateCommandAllocator(this.queue);
                    workerAllocators.push(shadowAllocator);
                    workerAllocators.push(sceneAllocator);
                    shadowCommandBuffers.push(Nri_CreateCommandBuffer(shadowAllocator));
                    sceneCommandBuffers.push(Nri_CreateCommandBuffer(sceneAllocator));
                }
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator),
                    Nri_CreateCommandBuffer(commandAllocator), Nri_CreateCommandBuffer(commandAllocator), workerAllocators,
                    shadowCommandBuffers, sceneCommandBuffers, sceneSet, shadowSet));
            }
            const blitSet = this.blit.createSet(descriptorPool, colorView);
            this.blitSet = blitSet;
            if (!blitSet) {
                console.log("Cannot create the descriptor sets");
                return false;
            }

            // The contexts' draw lists: context c draws c, c + 3, ...; the scene pass binds each draw's
            // material set (set 1).
            for (let c = 0; c < NUM_CONTEXTS; c++) {
                const shadowList = Nri_CreateDrawList();
                const sceneList = Nri_CreateDrawList();
                Nri_DrawListSetPipeline(shadowList, 0);
                Nri_DrawListSetPipeline(sceneList, 0);
                this.shadowLists.push(shadowList);
                this.sceneLists.push(sceneList);
            }
            // The materials' sets by diffuse texture, made as draws need them.
            const materialSetIndices: int[] = [];
            for (let i = 0; i < textureCount; i++) {
                materialSetIndices.push(-1);
            }
            const drawCount: int = Math.floor(SQUID_ROOM_DRAWS.length / SQUID_ROOM_DRAW_FIELDS);
            for (let j = 0; j < drawCount; j++) {
                const d = j * SQUID_ROOM_DRAW_FIELDS;
                const diffuse = SQUID_ROOM_DRAWS[d];
                if (materialSetIndices[diffuse] < 0) {
                    const set = Nri_AllocateDescriptorSet(descriptorPool, sceneLayout, 1, 0);
                    if (!set) {
                        console.log("Cannot create the descriptor sets");
                        return false;
                    }
                    Nri_UpdateDescriptor(set, 0, 0, this.textureViews[diffuse]);
                    Nri_UpdateDescriptor(set, 0, 1, this.textureViews[diffuse + 1]);
                    materialSetIndices[diffuse] = this.materialSets.length;
                    this.materialSets.push(set);
                }
                const startIndex = SQUID_ROOM_DRAWS[d + 1];
                const indexCount = SQUID_ROOM_DRAWS[d + 2];
                const baseVertex = SQUID_ROOM_DRAWS[d + 3];
                const c = j % NUM_CONTEXTS;
                Nri_DrawListDrawIndexed(this.shadowLists[c], indexCount, 1, startIndex, baseVertex, 0);
                Nri_DrawListSetDescriptorSet(this.sceneLists[c], 1, this.materialSets[materialSetIndices[diffuse]]);
                Nri_DrawListDrawIndexed(this.sceneLists[c], indexCount, 1, startIndex, baseVertex, 0);
            }

            // The contexts' passes: the shadow pass into the shadow map alone, the scene pass into the
            // color and depth buffers; neither clears (the main thread's command buffer does, before
            // them). Their set 0 is the queued frame's, set before each recording.
            for (let c = 0; c < NUM_CONTEXTS; c++) {
                const shadowPass = Nri_CreateDrawPass(this.shadowLists[c], null, shadowAttachment, WIDTH, HEIGHT, shadowLayout,
                    descriptorPool);
                Nri_DrawPassSetClearEnabled(shadowPass, 0);
                Nri_DrawPassSetIndexBuffer(shadowPass, indexBuffer);
                Nri_DrawPassSetVertexBuffer(shadowPass, vertexBuffer, SQUID_ROOM_VERTEX_STRIDE);
                Nri_DrawPassSetPipeline(shadowPass, 0, shadowPipeline);
                this.shadowPasses.push(shadowPass);
                const scenePass = Nri_CreateDrawPass(this.sceneLists[c], colorAttachment, depthAttachment, WIDTH, HEIGHT, sceneLayout,
                    descriptorPool);
                Nri_DrawPassSetClearEnabled(scenePass, 0);
                Nri_DrawPassSetIndexBuffer(scenePass, indexBuffer);
                Nri_DrawPassSetVertexBuffer(scenePass, vertexBuffer, SQUID_ROOM_VERTEX_STRIDE);
                Nri_DrawPassSetPipeline(scenePass, 0, scenePipeline);
                this.scenePasses.push(scenePass);
            }
            return true;
        }

        // Where a queued frame's constants are: the scene pass's, the shadow pass's.
        sceneOffset(queuedFrameIndex: int) {
            return queuedFrameIndex * 2 * CONSTANTS_SIZE;
        }

        shadowOffset(queuedFrameIndex: int) {
            return this.sceneOffset(queuedFrameIndex) + CONSTANTS_SIZE;
        }

        // Waits for the frame that last used this frame's command allocators.
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
            for (const workerAllocator of queuedFrame.workerAllocators) {
                Nri_ResetCommandAllocator(workerAllocator);
            }
        }

        // OnUpdate: the camera turned by the arrow keys, the lights circling the room (the first and
        // third one way, the second the other) and looking at its middle, the constants.
        update(elapsedSeconds: number) {
            const frameTime = Math.fround(elapsedSeconds);
            const frameChange = Math.fround(2.0 * frameTime);
            if (!this.test) {
                if (Nri_IsKeyPressed(this.sample, KEY_LEFT) != 0) {
                    this.camera.rotateYaw(-frameChange);
                }
                if (Nri_IsKeyPressed(this.sample, KEY_RIGHT) != 0) {
                    this.camera.rotateYaw(frameChange);
                }
                if (Nri_IsKeyPressed(this.sample, KEY_UP) != 0) {
                    this.camera.rotatePitch(frameChange);
                }
                if (Nri_IsKeyPressed(this.sample, KEY_DOWN) != 0) {
                    this.camera.rotatePitch(-frameChange);
                }
                if (Nri_IsKeyToggled(this.sample, NriKey.Space) != 0) {
                    this.animate = !this.animate;
                }
            }

            if (this.animate) {
                for (let i = 0; i < NUM_LIGHTS; i++) {
                    const light = this.lights[i];
                    const direction = i % 2 == 0 ? frameChange : -frameChange;
                    light.position = transform4(light.position, matrixRotationY(direction));
                    const eye = light.position;
                    const at = [0.0, 8.0, 0.0, 0.0];
                    light.direction = normalize3(vsub(at, eye));
                    const lightCamera = this.lightCameras[i];
                    lightCamera.set(eye, at, [0.0, 1.0, 0.0, 0.0]);
                    light.view = lightCamera.viewMatrix();
                    light.projection = lightCamera.projectionMatrix(90.0, WIDTH, HEIGHT);
                }
            }

            this.fillConstants(this.sceneConstants, this.camera, 1);
            this.fillConstants(this.shadowConstants, this.lightCameras[0], 0);
        }

        // FrameResource::WriteConstantBuffers: the scene pass seen from the camera, sampling the
        // shadow map; the shadow pass seen from the first light.
        fillConstants(constants: f32[], camera: Camera, sampleShadowMap: int) {
            // Scale down the world a bit.
            const scale = Math.fround(0.1);
            for (let k = 0; k < 16; k++) {
                constants[k] = 0.0;
            }
            constants[0] = scale;
            constants[5] = scale;
            constants[10] = scale;
            constants[15] = 1.0;
            const view = camera.viewMatrix();
            const projection = camera.projectionMatrix(90.0, WIDTH, HEIGHT);
            for (let k = 0; k < 16; k++) {
                constants[16 + k] = view[k];
                constants[32 + k] = projection[k];
            }
            constants[48] = Math.fround(0.1);
            constants[49] = Math.fround(0.2);
            constants[50] = Math.fround(0.3);
            constants[51] = 1.0;
            Nri_StoreInt32(Ref(constants[52]), sampleShadowMap);
            for (let i = 0; i < NUM_LIGHTS; i++) {
                const light = this.lights[i];
                const base = CONSTANTS_LIGHTS + i * LIGHT_FLOATS;
                for (let k = 0; k < 4; k++) {
                    constants[base + k] = light.position[k];
                    constants[base + 4 + k] = light.direction[k];
                    constants[base + 8 + k] = light.color[k];
                    constants[base + 12 + k] = light.falloff[k];
                }
                for (let k = 0; k < 16; k++) {
                    constants[base + 16 + k] = light.view[k];
                    constants[base + 32 + k] = light.projection[k];
                }
            }
        }

        // The swap chain at the window's size, its textures' views and semaphores.
        createSwapChain(device: NriDeviceHandle) {
            this.width = Nri_GetOutputWidth(this.sample);
            this.height = Nri_GetOutputHeight(this.sample);
            this.swapChain = Nri_CreateSwapChain(this.sample, device, this.queue, Nri_GetQueuedFrameNum(this.sample) + 1);
            const textureNum = Nri_GetSwapChainTextureNum(this.swapChain);
            const format = Nri_GetTextureFormat(Nri_GetSwapChainTexture(this.swapChain, 0));
            this.swapChainFormat = format;
            this.viewFormat = format;
            for (let i = 0; i < textureNum; i++) {
                const texture = Nri_GetSwapChainTexture(this.swapChain, i);
                this.swapChainTextures.push(new SwapChainTexture(texture, Nri_CreateColorAttachmentView(texture, format),
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

        // The window was resized (Nri_UseResizableWindow): the swap chain made
        // again at its size, once the GPU is done with the old ones.
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
        }

        // OnRender: the constants written, the workers recording the passes' draws while the main
        // thread records the clears (the sample's BeginFrame) and the rest; then everything submitted
        // in the sample's order, and the frame blitted into the swap chain texture.
        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            const constantBuffer = this.constantBuffer;
            if (!constantBuffer) {
                return;
            }
            this.update(this.test ? Math.fround(1.0 / 60.0) : Nri_GetFrameTime(this.sample));
            Nri_WriteBuffer(constantBuffer, this.sceneOffset(queuedFrameIndex), Ref(this.sceneConstants[0]), CONSTANTS_SIZE);
            Nri_WriteBuffer(constantBuffer, this.shadowOffset(queuedFrameIndex), Ref(this.shadowConstants[0]), CONSTANTS_SIZE);

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                this.recordAndSubmit(frameIndex, queuedFrame, this.swapChainTextures[index], acquireSemaphore);
            }

            // Signaled after the present, as NRISamples do
            Nri_QueueSignal(this.queue, this.frameFence, 1 + frameIndex);
        }

        // Records the frame (the workers' passes on their threads unless -singleThreaded), submits it
        // and presents.
        recordAndSubmit(frameIndex: int, queuedFrame: QueuedFrame, swapChainTexture: SwapChainTexture, acquireSemaphore: NriFenceHandle) {
            const descriptorPool = this.descriptorPool;
            const blitSet = this.blitSet;
            const colorBuffer = this.colorBuffer;
            const colorAttachment = this.colorAttachment;
            const depthAttachment = this.depthAttachment;
            const shadowMap = this.shadowMap;
            const shadowAttachment = this.shadowAttachment;
            if (!descriptorPool || !blitSet || !colorBuffer || !colorAttachment || !depthAttachment || !shadowMap || !shadowAttachment) {
                return;
            }

            // The workers: each context's shadow pass, then its scene pass, with this frame's sets.
            for (let c = 0; c < NUM_CONTEXTS; c++) {
                Nri_DrawPassSetDescriptorSet(this.shadowPasses[c], 0, queuedFrame.shadowSet);
                Nri_DrawPassSetDescriptorSet(this.scenePasses[c], 0, queuedFrame.sceneSet);
                if (this.singleThreaded) {
                    Nri_RecordDrawPass(this.shadowPasses[c], queuedFrame.shadowCommandBuffers[c]);
                    Nri_RecordDrawPass(this.scenePasses[c], queuedFrame.sceneCommandBuffers[c]);
                } else {
                    Nri_RecordDrawPassAsync(this.shadowPasses[c], queuedFrame.shadowCommandBuffers[c]);
                    Nri_RecordDrawPassAsync(this.scenePasses[c], queuedFrame.sceneCommandBuffers[c]);
                }
            }

            // The sample's BeginFrame: the shadow map cleared to 1, the color buffer to black (alpha
            // 1), the depth buffer to 1.
            const pre = queuedFrame.preCommandBuffer;
            Nri_BeginCommandBuffer(pre);
            Nri_CmdTextureBarrier(pre, shadowMap, NriTextureState.ShaderResource, NriTextureState.DepthAttachment);
            Nri_CmdBeginRenderingDepthOnly(pre, shadowAttachment);
            Nri_CmdClearDepth(pre, 1.0);
            Nri_CmdEndRendering(pre);
            Nri_CmdTextureBarrier(pre, colorBuffer, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            Nri_CmdBeginRenderingWithDepth(pre, colorAttachment, depthAttachment);
            Nri_CmdClearColor(pre, 0.0, 0.0, 0.0, 1.0);
            Nri_CmdClearDepth(pre, 1.0);
            Nri_CmdEndRendering(pre);
            Nri_EndCommandBuffer(pre);

            // Between the passes: the shadow map read by the scene pass.
            const mid = queuedFrame.midCommandBuffer;
            Nri_BeginCommandBuffer(mid);
            Nri_CmdTextureBarrier(mid, shadowMap, NriTextureState.DepthAttachment, NriTextureState.ShaderResource);
            Nri_EndCommandBuffer(mid);

            // The color buffer blitted into the swap chain texture (Donut's blit).
            const post = queuedFrame.postCommandBuffer;
            Nri_BeginCommandBuffer(post);
            Nri_CmdSetDescriptorPool(post, descriptorPool);
            Nri_CmdTextureBarrier(post, colorBuffer, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
            Nri_CmdTextureBarrier(post, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
            Nri_CmdBeginRendering(post, swapChainTexture.colorAttachment);
            this.blit.record(post, blitSet, this.width, this.height);
            Nri_CmdEndRendering(post);

            // The test's last frame: read back
            let presentFrom = NriTextureState.ColorAttachment;
            const readbackBuffer = this.readbackBuffer;
            if (readbackBuffer) {
                if (frameIndex == TEST_FRAMES - 1) {
                    Nri_CmdTextureBarrier(post, swapChainTexture.texture, NriTextureState.ColorAttachment, NriTextureState.CopySource);
                    Nri_CmdReadbackTextureToBuffer(post, readbackBuffer, this.rowPitch, swapChainTexture.texture, this.width, this.height);
                    presentFrom = NriTextureState.CopySource;
                }
            }
            Nri_CmdTextureBarrier(post, swapChainTexture.texture, presentFrom, NriTextureState.Present);
            Nri_EndCommandBuffer(post);

            if (!this.singleThreaded) {
                for (let c = 0; c < NUM_CONTEXTS; c++) {
                    Nri_WaitDrawPass(this.shadowPasses[c]);
                    Nri_WaitDrawPass(this.scenePasses[c]);
                }
            }

            // Submit in the sample's order: the clears, the shadow passes, the scene passes; then the
            // blit, and present.
            Nri_QueueSubmitCommandBuffer(this.queue, pre);
            for (let c = 0; c < NUM_CONTEXTS; c++) {
                Nri_QueueSubmitCommandBuffer(this.queue, queuedFrame.shadowCommandBuffers[c]);
            }
            Nri_QueueSubmitCommandBuffer(this.queue, mid);
            for (let c = 0; c < NUM_CONTEXTS; c++) {
                Nri_QueueSubmitCommandBuffer(this.queue, queuedFrame.sceneCommandBuffers[c]);
            }
            Nri_QueueSubmit(this.queue, post, acquireSemaphore, swapChainTexture.releaseSemaphore);
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
                // (Destroying a pass waits for its worker.)
                for (const pass of this.shadowPasses) {
                    Nri_DestroyDrawPass(pass);
                }
                for (const pass of this.scenePasses) {
                    Nri_DestroyDrawPass(pass);
                }
                for (const list of this.shadowLists) {
                    Nri_DestroyDrawList(list);
                }
                for (const list of this.sceneLists) {
                    Nri_DestroyDrawList(list);
                }
                for (const queuedFrame of this.queuedFrames) {
                    Nri_DestroyCommandBuffer(queuedFrame.preCommandBuffer);
                    Nri_DestroyCommandBuffer(queuedFrame.midCommandBuffer);
                    Nri_DestroyCommandBuffer(queuedFrame.postCommandBuffer);
                    for (let c = 0; c < NUM_CONTEXTS; c++) {
                        Nri_DestroyCommandBuffer(queuedFrame.shadowCommandBuffers[c]);
                        Nri_DestroyCommandBuffer(queuedFrame.sceneCommandBuffers[c]);
                    }
                    for (const workerAllocator of queuedFrame.workerAllocators) {
                        Nri_DestroyCommandAllocator(workerAllocator);
                    }
                    Nri_DestroyCommandAllocator(queuedFrame.commandAllocator);
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
                this.blit.destroy();
                const descriptors = [this.colorAttachment, this.colorView, this.depthAttachment, this.shadowAttachment, this.shadowView,
                    this.wrapSampler, this.clampSampler];
                for (const descriptor of descriptors) {
                    if (descriptor) {
                        Nri_DestroyDescriptor(descriptor);
                    }
                }
                for (const view of this.textureViews) {
                    Nri_DestroyDescriptor(view);
                }
                for (const view of this.constantViews) {
                    Nri_DestroyDescriptor(view);
                }
                for (const texture of this.textures) {
                    Nri_DestroyTexture(texture);
                }
                const targets = [this.colorBuffer, this.depthBuffer, this.shadowMap];
                for (const texture of targets) {
                    if (texture) {
                        Nri_DestroyTexture(texture);
                    }
                }
                const buffers = [this.vertexBuffer, this.indexBuffer, this.constantBuffer, this.readbackBuffer];
                for (const buffer of buffers) {
                    if (buffer) {
                        Nri_DestroyBuffer(buffer);
                    }
                }
                const pipelines = [this.scenePipeline, this.shadowPipeline];
                for (const pipeline of pipelines) {
                    if (pipeline) {
                        Nri_DestroyPipeline(pipeline);
                    }
                }
                const layouts = [this.sceneLayout, this.shadowLayout];
                for (const layout of layouts) {
                    if (layout) {
                        Nri_DestroyPipelineLayout(layout);
                    }
                }
                Nri_DestroyFence(this.frameFence);
                Nri_DestroySwapChain(this.swapChain);
                Nri_DestroyDevice(device);
            }
            Nri_DestroySample(this.sample);
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        Nri_UseResizableWindow(sample);
        const multithreading = new Multithreading(sample);
        // -singleThreaded: record the draws on the main thread. -noUI: accepted, as Donut's examples
        // accept it (the example has no UI).
        Nri_AddExampleOption(sample, "-singleThreaded");
        Nri_AddExampleOption(sample, "-noUI");
        for (let i = 1; i < argc; i++) {
            if (Nri_GetArg(argc, argv, i) == "-singleThreaded") {
                multithreading.singleThreaded = true;
            }
        }
        return multithreading.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return MultithreadingNri.main(argc, argv);
}

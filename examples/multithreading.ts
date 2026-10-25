// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import {
    cross3, matrixLookAtRH, matrixPerspectiveFovRH, matrixRotationAxis, matrixRotationY, matrixTranspose,
    normalize3, transform4, transformCoord3, vsub, XM_PI,
} from "../core/directx_math";
import {
    SQUID_ROOM_DRAW_FIELDS, SQUID_ROOM_DRAWS, SQUID_ROOM_INDEX_DATA_OFFSET, SQUID_ROOM_INDEX_DATA_SIZE,
    SQUID_ROOM_TEXTURE_FIELDS, SQUID_ROOM_TEXTURES, SQUID_ROOM_VERTEX_DATA_OFFSET, SQUID_ROOM_VERTEX_DATA_SIZE,
    SQUID_ROOM_VERTEX_STRIDE,
} from "../core/squid_room";

namespace Multithreading {
    const WINDOW_TITLE = "D3D12 Multithreading Sample";
    const DATA_FILE = "media/multithreading/SquidRoom.bin";

    // The sample's worker threads ("contexts"), each recording every third draw of both passes,
    // and its lights (keep in sync with multithreading.hlsl).
    const NUM_CONTEXTS = 3;
    const NUM_LIGHTS = 3;

    // The sample's viewport, shadow maps and depth buffer: 1280 x 720 (the shader's PCF assumes the
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

    // Test mode: the frames rendered, each 1/60 s.
    const TEST_FRAMES = 60;

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

    // Port of DirectX-Graphics-Samples' D3D12Multithreading: the SquidRoom scene (1025 draws) lit by
    // three spotlights circling it, the first casting a shadow (a shadow pass from it, then 2 x 2
    // PCF), each frame's draws recorded by three worker threads, each into a shadow pass command
    // list and a scene pass command list of its own. The threads are the app's thread pool here,
    // recording draw batches described at load time (tslang code mustn't run on other threads);
    // the main thread meanwhile records the constant buffer updates and clears. The sample runs
    // its shadow command lists while its threads still record the scene; here all are executed
    // once recorded, in its order: clears, shadow passes, scene passes. Its R8G8B8A8_UNORM back
    // buffer and D32_FLOAT depth buffer are textures here, blitted into the back buffer; one shadow
    // map and pair of constant buffers serve all frames (the sample has them per frame resource).
    class MultithreadingPass {
        private app: App;
        private sceneVertexShader: ShaderHandle;
        private shadowVertexShader: ShaderHandle;
        private pixelShader: ShaderHandle;
        private sceneInputLayout: InputLayoutHandle;
        private shadowInputLayout: InputLayoutHandle;
        private sceneBindingLayout: BindingLayoutHandle;
        private materialBindingLayout: BindingLayoutHandle;
        private shadowBindingLayout: BindingLayoutHandle;
        private vertexBuffer: BufferHandle;
        private indexBuffer: BufferHandle;
        private colorBuffer: TextureHandle;
        private depthBuffer: TextureHandle;
        private shadowMap: TextureHandle;
        private sceneFramebuffer: FramebufferHandle;
        private shadowFramebuffer: FramebufferHandle;
        private sceneConstantBuffer: BufferHandle;
        private shadowConstantBuffer: BufferHandle;
        private sceneBatch: DrawBatch;
        private shadowBatch: DrawBatch;
        // The main thread's command list (the sample's "pre" one) and the workers'.
        private preCommandList: CommandList;
        private shadowCommandLists: CommandList[];
        private sceneCommandLists: CommandList[];
        private sceneConstants: f32[];
        private shadowConstants: f32[];
        private camera: Camera;
        private lights: Light[];
        private lightCameras: Camera[];
        // Arrow keys: left, right, up, down.
        private keys: int[];
        private animate: boolean;
        // -singleThreaded: the draws recorded one context after another on the main thread (the
        // sample's SINGLETHREADED).
        singleThreaded: boolean;

        constructor(app: App) {
            this.app = app;
            this.shadowCommandLists = [];
            this.sceneCommandLists = [];
            this.sceneConstants = [];
            this.shadowConstants = [];
            for (let i = 0; i < CONSTANTS_FLOATS; i++) {
                this.sceneConstants.push(0.0);
                this.shadowConstants.push(0.0);
            }
            this.camera = new Camera();
            this.lights = [];
            this.lightCameras = [];
            for (let i = 0; i < NUM_LIGHTS; i++) {
                const light = new Light();
                this.lights.push(light);
                const lightCamera = new Camera();
                const eye = light.position;
                const at = [eye[0] + light.direction[0], eye[1] + light.direction[1], eye[2] + light.direction[2], eye[3] + light.direction[3]];
                lightCamera.set(eye, at, [0.0, 1.0, 0.0, 0.0]);
                this.lightCameras.push(lightCamera);
            }
            this.keys = [0, 0, 0, 0];
            this.animate = true;
            this.singleThreaded = false;
        }

        init() {
            const shader = "multithreading.hlsl";
            this.sceneVertexShader = this.app.createShader(shader, "VSMain", ShaderType.Vertex);
            this.shadowVertexShader = this.app.createShader(shader, "VSShadow", ShaderType.Vertex);
            this.pixelShader = this.app.createShader(shader, "PSMain", ShaderType.Pixel);
            if (!this.sceneVertexShader || !this.shadowVertexShader || !this.pixelShader) {
                return false;
            }
            // The sample's 44-byte vertices: position, normal, texture coordinates, tangent. The
            // shadow pass reads the positions only.
            const sceneLayoutDesc = InputLayoutDesc.create();
            sceneLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, SQUID_ROOM_VERTEX_STRIDE);
            sceneLayoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, 12, 0, SQUID_ROOM_VERTEX_STRIDE);
            sceneLayoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 24, 0, SQUID_ROOM_VERTEX_STRIDE);
            sceneLayoutDesc.addVertexAttribute("TANGENT", Format.RGB32_FLOAT, 32, 0, SQUID_ROOM_VERTEX_STRIDE);
            this.sceneInputLayout = this.app.createInputLayout(sceneLayoutDesc, this.sceneVertexShader);
            const shadowLayoutDesc = InputLayoutDesc.create();
            shadowLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, SQUID_ROOM_VERTEX_STRIDE);
            this.shadowInputLayout = this.app.createInputLayout(shadowLayoutDesc, this.shadowVertexShader);

            // The sample's root signature: the pass's constant buffer, the shadow map and the
            // samplers (register space 0), and the draw's diffuse and normal maps (space 1). The
            // shadow pass reads its constant buffer only.
            const sceneLayout = BindingLayoutDesc.create();
            sceneLayout.setDescriptorSet(0);
            sceneLayout.layoutConstantBuffer(0);
            sceneLayout.layoutTextureSRV(0);
            sceneLayout.layoutSampler(0);
            sceneLayout.layoutSampler(1);
            this.sceneBindingLayout = this.app.createBindingLayout(sceneLayout, ShaderType.All);
            const materialLayout = BindingLayoutDesc.create();
            materialLayout.setDescriptorSet(1);
            materialLayout.layoutTextureSRV(1);
            materialLayout.layoutTextureSRV(2);
            this.materialBindingLayout = this.app.createBindingLayout(materialLayout, ShaderType.Pixel);
            const shadowLayout = BindingLayoutDesc.create();
            shadowLayout.layoutConstantBuffer(0);
            this.shadowBindingLayout = this.app.createBindingLayout(shadowLayout, ShaderType.Vertex);

            this.sceneConstantBuffer = this.app.createConstantBuffer(CONSTANTS_FLOATS * 4, "SceneConstantBuffer");
            this.shadowConstantBuffer = this.app.createConstantBuffer(CONSTANTS_FLOATS * 4, "ShadowConstantBuffer");

            this.colorBuffer = this.app.createRenderTargetTexture(WIDTH, HEIGHT, Format.RGBA8_UNORM, "ColorBuffer");
            this.depthBuffer = this.app.createRenderTargetTexture(WIDTH, HEIGHT, Format.D32, "DepthBuffer");
            this.shadowMap = this.app.createRenderTargetTexture(WIDTH, HEIGHT, Format.D32, "ShadowMap");
            this.sceneFramebuffer = this.app.createFramebuffer(this.colorBuffer, this.depthBuffer);
            this.shadowFramebuffer = this.app.createDepthFramebuffer(this.shadowMap);

            // The sample's pipeline states: back faces culled, depth tested (less or equal) and
            // written, clipped at the near and far planes (D3D12's default); the shadow pass's
            // without a pixel shader.
            const sceneDesc = GraphicsPipelineDesc.create(this.sceneVertexShader, this.pixelShader);
            sceneDesc.setInputLayout(this.sceneInputLayout);
            sceneDesc.addBindingLayout(this.sceneBindingLayout);
            sceneDesc.addBindingLayout(this.materialBindingLayout);
            sceneDesc.setDepthState(1, 1, ComparisonFunc.LessOrEqual);
            sceneDesc.setDepthClip(1);
            const scenePipeline = this.app.createGraphicsPipelineFromDesc(sceneDesc, this.sceneFramebuffer);
            const shadowDesc = GraphicsPipelineDesc.create(this.shadowVertexShader, null);
            shadowDesc.setInputLayout(this.shadowInputLayout);
            shadowDesc.addBindingLayout(this.shadowBindingLayout);
            shadowDesc.setDepthState(1, 1, ComparisonFunc.LessOrEqual);
            shadowDesc.setDepthClip(1);
            const shadowPipeline = this.app.createGraphicsPipelineFromDesc(shadowDesc, this.shadowFramebuffer);

            // Blitting creates Donut's common passes: before any command list is open.
            this.app.getCommonSampler(CommonSampler.LinearClamp);
            const commandList = this.app.createCommandList();
            commandList.open();
            const ok = this.loadAssets(commandList, scenePipeline, shadowPipeline);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);
            if (!ok) {
                return false;
            }

            this.preCommandList = this.app.createDeferredCommandList();
            for (let i = 0; i < NUM_CONTEXTS; i++) {
                this.shadowCommandLists.push(this.app.createDeferredCommandList());
                this.sceneCommandLists.push(this.app.createDeferredCommandList());
            }

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setAnimateCallback(this.onAnimate);
            pass.setRenderCallback(this.onRender);
            return true;
        }

        onKey(key: Key, scancode: int, action: Action, mods: KeyMods) {
            if (action != Action.Press && action != Action.Release) {
                return 0;
            }
            const down = action == Action.Press ? 1 : 0;
            if (key == Key.Left) {
                this.keys[0] = down;
            } else if (key == Key.Right) {
                this.keys[1] = down;
            } else if (key == Key.Up) {
                this.keys[2] = down;
            } else if (key == Key.Down) {
                this.keys[3] = down;
            } else if (key == Key.Space) {
                if (action == Action.Press) {
                    this.animate = !this.animate;
                }
            } else {
                return 0;
            }
            return 1;
        }

        // OnUpdate: the camera turned by the arrow keys, the lights circling the room (the first and
        // third one way, the second the other) and looking at its middle, the constant buffers.
        onAnimate(elapsedSeconds: number) {
            this.app.setInformativeWindowTitleWithInfo(WINDOW_TITLE, this.singleThreaded ? "(single-threaded)" : "(3 threads)");
            const frameTime = Math.fround(elapsedSeconds);
            const frameChange = Math.fround(2.0 * frameTime);
            if (this.keys[0] != 0) {
                this.camera.rotateYaw(-frameChange);
            }
            if (this.keys[1] != 0) {
                this.camera.rotateYaw(frameChange);
            }
            if (this.keys[2] != 0) {
                this.camera.rotatePitch(frameChange);
            }
            if (this.keys[3] != 0) {
                this.camera.rotatePitch(-frameChange);
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

            this.writeConstants(this.sceneConstants, this.camera, 1);
            this.writeConstants(this.shadowConstants, this.lightCameras[0], 0);
        }

        // FrameResource::WriteConstantBuffers: the scene pass seen from the camera, sampling the
        // shadow map; the shadow pass seen from the first light.
        writeConstants(constants: f32[], camera: Camera, sampleShadowMap: int) {
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
            Donut_StoreInt32(Ref(constants[52]), sampleShadowMap);
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

        // OnRender: the main thread records the constant buffer writes and the clears (the sample's
        // BeginFrame) while the workers record the passes' draws; then everything is executed, and
        // the frame blitted to the back buffer.
        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            for (let i = 0; i < NUM_CONTEXTS; i++) {
                if (this.singleThreaded) {
                    this.shadowBatch.record(this.shadowCommandLists[i], i, NUM_CONTEXTS);
                    this.sceneBatch.record(this.sceneCommandLists[i], i, NUM_CONTEXTS);
                } else {
                    this.app.recordDrawBatchAsync(this.shadowBatch, this.shadowCommandLists[i], i, NUM_CONTEXTS);
                    this.app.recordDrawBatchAsync(this.sceneBatch, this.sceneCommandLists[i], i, NUM_CONTEXTS);
                }
            }

            const pre = this.preCommandList;
            pre.open();
            pre.writeBuffer(this.sceneConstantBuffer, Ref(this.sceneConstants[0]), CONSTANTS_FLOATS * 4);
            pre.writeBuffer(this.shadowConstantBuffer, Ref(this.shadowConstants[0]), CONSTANTS_FLOATS * 4);
            pre.clearDepth(this.shadowMap, 1.0);
            pre.clearTextureFloat(this.colorBuffer, 0.0, 0.0, 0.0, 1.0);
            pre.clearDepth(this.depthBuffer, 1.0);
            pre.close();

            if (!this.singleThreaded) {
                this.app.waitForTasks();
            }

            // Before the frame's command list, which the pass executes after this callback returns.
            this.app.executeCommandList(pre);
            for (let i = 0; i < NUM_CONTEXTS; i++) {
                this.app.executeCommandList(this.shadowCommandLists[i]);
            }
            for (let i = 0; i < NUM_CONTEXTS; i++) {
                this.app.executeCommandList(this.sceneCommandLists[i]);
            }
            this.app.blitTexture(frame, this.colorBuffer);
        }

        // LoadAssets: the mesh and the textures from the data file, the passes' binding sets (a
        // binding set per diffuse texture: the sample's descriptor table of the diffuse texture and
        // the one after it as the normal map) and their draw batches.
        loadAssets(commandList: CommandList, scenePipeline: GraphicsPipelineHandle, shadowPipeline: GraphicsPipelineHandle) {
            const binaryFile = this.app.loadBinaryFile(DATA_FILE);
            if (binaryFile.isNull()) {
                console.log(`Cannot load ${DATA_FILE} (the sample's data: build with DIRECTX_GRAPHICS_SAMPLES_DIR set)`);
                return false;
            }
            this.vertexBuffer = this.app.createStaticBufferFromBinaryFile(commandList, binaryFile,
                SQUID_ROOM_VERTEX_DATA_OFFSET, SQUID_ROOM_VERTEX_DATA_SIZE, 0, "SquidRoomVertices");
            this.indexBuffer = this.app.createStaticBufferFromBinaryFile(commandList, binaryFile,
                SQUID_ROOM_INDEX_DATA_OFFSET, SQUID_ROOM_INDEX_DATA_SIZE, 1, "SquidRoomIndices");
            if (!this.vertexBuffer || !this.indexBuffer) {
                return false;
            }
            const textureCount = SQUID_ROOM_TEXTURES.length / SQUID_ROOM_TEXTURE_FIELDS;
            const textures: TextureHandle[] = [];
            for (let i = 0; i < textureCount; i++) {
                const t = i * SQUID_ROOM_TEXTURE_FIELDS;
                const format = SQUID_ROOM_TEXTURES[t + 2] == 0 ? Format.BC1_UNORM : Format.RGBA8_UNORM;
                const texture = this.app.createTextureWithLevels(SQUID_ROOM_TEXTURES[t], SQUID_ROOM_TEXTURES[t + 1], 1, format, "SquidRoomTexture");
                binaryFile.writeTextureLevelFromBinaryFile(commandList, texture, 0, SQUID_ROOM_TEXTURES[t + 3], SQUID_ROOM_TEXTURES[t + 4]);
                textures.push(texture);
            }
            this.app.releaseObject(binaryFile.handle);

            // The sample's samplers: linear and wrapping for the textures, point and clamped for the
            // shadow map.
            const wrapSampler = this.app.createSampler(1, 1, 1);
            const clampSampler = this.app.createSampler(0, 0, 0);

            const sceneSetDesc = BindingSetDesc.create();
            sceneSetDesc.bindConstantBuffer(0, this.sceneConstantBuffer, 0, CONSTANTS_FLOATS * 4);
            sceneSetDesc.bindTextureSRV(0, this.shadowMap);
            sceneSetDesc.bindSampler(0, wrapSampler);
            sceneSetDesc.bindSampler(1, clampSampler);
            const sceneSet = this.app.createBindingSetForLayout(sceneSetDesc, this.sceneBindingLayout);
            const shadowSetDesc = BindingSetDesc.create();
            shadowSetDesc.bindConstantBuffer(0, this.shadowConstantBuffer, 0, CONSTANTS_FLOATS * 4);
            const shadowSet = this.app.createBindingSetForLayout(shadowSetDesc, this.shadowBindingLayout);

            this.sceneBatch = this.app.createDrawBatch(scenePipeline, this.sceneFramebuffer, this.vertexBuffer, this.indexBuffer);
            this.shadowBatch = this.app.createDrawBatch(shadowPipeline, this.shadowFramebuffer, this.vertexBuffer, this.indexBuffer);
            this.sceneBatch.addBindingSet(sceneSet);
            this.shadowBatch.addBindingSet(shadowSet);
            // The materials' binding sets by diffuse texture, made as draws need them.
            const materialSets: BindingSet[] = [];
            const materialSetIndices: int[] = [];
            for (let i = 0; i < textureCount; i++) {
                materialSetIndices.push(-1);
            }
            const drawCount = SQUID_ROOM_DRAWS.length / SQUID_ROOM_DRAW_FIELDS;
            for (let j = 0; j < drawCount; j++) {
                const d = j * SQUID_ROOM_DRAW_FIELDS;
                const diffuse = SQUID_ROOM_DRAWS[d];
                if (materialSetIndices[diffuse] < 0) {
                    const setDesc = BindingSetDesc.create();
                    setDesc.bindTextureSRV(1, textures[diffuse]);
                    setDesc.bindTextureSRV(2, textures[diffuse + 1]);
                    materialSetIndices[diffuse] = materialSets.length;
                    materialSets.push(this.app.createBindingSetForLayout(setDesc, this.materialBindingLayout));
                }
                const startIndex = SQUID_ROOM_DRAWS[d + 1];
                const indexCount = SQUID_ROOM_DRAWS[d + 2];
                const baseVertex = SQUID_ROOM_DRAWS[d + 3];
                this.shadowBatch.addDraw(null, indexCount, startIndex, baseVertex);
                this.sceneBatch.addDraw(materialSets[materialSetIndices[diffuse]], indexCount, startIndex, baseVertex);
            }
            return true;
        }
    }

    // -test: checks the last frame: the room, textured and lit (ambient light alone leaves it dark:
    // a mean brightness around 25), fills it. (Against the sample's frame 60, its time step fixed
    // at 1/60 s: 21 of 921600 pixels differed on D3D12, 17 on Vulkan, nearly all by 1/255.)
    function checkFrame(app: App) {
        const width = app.getWindowWidth();
        const height = app.getWindowHeight();
        const pixels: int[] = [];
        for (let i = 0; i < width * height; i++) {
            pixels.push(0);
        }
        if (app.readBackBufferRGBA8(Ref(pixels[0]), pixels.length) == 0) {
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

    class MultithreadingArgs extends Args {
        // -singleThreaded: record the draws on the main thread.
        singleThreaded = false;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-singleThreaded") {
                    this.singleThreaded = true;
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("multithreading");

        // -test [-testOutput <file>]: render 60 frames (at 60 a second) without a window and check
        // the last one (see checkFrame).
        const args = new MultithreadingArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        // The sample's window, with UNORM back buffers, as the sample's R8G8B8A8_UNORM.
        const options = AppOptions.UnormBackBuffer | args.options;
        const app = App.createWithOptions(args.api, WINDOW_TITLE, WIDTH, HEIGHT, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        const pass = new MultithreadingPass(app);
        pass.singleThreaded = args.singleThreaded;
        if (!pass.init()) {
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        let result = 0;
        if (args.test) {
            result =app.finishTest(checkFrame(app));
        }
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return Multithreading.main(argc, argv);
}

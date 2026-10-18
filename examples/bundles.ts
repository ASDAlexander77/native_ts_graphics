// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { matrixMultiply, matrixPerspectiveFovRH, matrixTranslation, matrixTranspose } from "../core/directx_math";
import { SimpleCamera } from "../core/simple_camera";
import { ACTION_RELEASE, ACTION_PRESS } from "../core/glfw_input";

namespace Bundles {
    const WINDOW_TITLE = "D3D12 Bundles Sample";
    const DATA_FILE = "media/bundles/occcity.bin";

    // The sample's cities: 10 rows of 3, 8 units apart.
    const CITY_ROW_COUNT = 10;
    const CITY_COLUMN_COUNT = 3;
    const CITY_COUNT = CITY_ROW_COUNT * CITY_COLUMN_COUNT;
    const CITY_INTERVAL_X = 8.0;
    const CITY_INTERVAL_Z = -8.0;

    // occcity.h: the data file's parts. The city's diffuse texture (BC1, 1024 x 1024, its pitch
    // 2048 bytes) at 0; the vertices (position, normal, texture coordinates, tangent: 44 bytes)
    // and the 32-bit indices after it.
    const TEXTURE_SIZE = 1024;
    const TEXTURE_PITCH = 2048;
    const VERTEX_STRIDE = 44;
    const VERTEX_DATA_OFFSET = 524288;
    const VERTEX_DATA_SIZE = 820248;
    const INDEX_DATA_OFFSET = 1344536;
    const INDEX_DATA_SIZE = 74568;

    // SceneConstantBuffer: a city's model-view-projection matrix (transposed), padded to 256 bytes,
    // one after another in a constant buffer.
    const CONSTANTS_STRIDE = 256;
    const CONSTANTS_STRIDE_FLOATS = CONSTANTS_STRIDE / 4;

    // The sample's clear color, (0, 0.2, 0.4).
    const CLEAR_R = 0.0;
    const CLEAR_G = 0.2;
    const CLEAR_B = 0.4;

    // Test mode: the frames rendered, each 1/60 s.
    const TEST_FRAMES = 3;

    // Port of DirectX-Graphics-Samples' D3D12Bundles: 30 copies of a city in 10 rows of 3, drawn
    // with two pipeline states taking turns (the second's pixel shader filters out most of the red
    // and blue), each city with a constant buffer view of its own. The sample records the draws
    // once into a bundle per frame resource and has its command list execute it every frame;
    // NVRHI has no bundles, so here the draws are a draw batch described once (DrawBatch in
    // core/donut_interop.cpp: its pipelines, binding sets and index ranges) that each frame's
    // command list executes. The sample's back buffer (R8G8B8A8_UNORM) and D32_FLOAT depth buffer
    // are a color target here, blitted into the back buffer.
    class BundlesPass {
        private app: App;
        private vertexShader: ShaderHandle;
        private pixelShader: ShaderHandle;
        private altPixelShader: ShaderHandle;
        private inputLayout: InputLayoutHandle;
        private bindingLayout: BindingLayoutHandle;
        // A binding set per city: its slice of the constant buffer, the texture, the sampler.
        private bindingSets: BindingSet[];
        private vertexBuffer: BufferHandle;
        private indexBuffer: BufferHandle;
        private constantBuffer: BufferHandle;
        private hasTargets: boolean;
        private colorBuffer: TextureHandle;
        private depthBuffer: TextureHandle;
        private framebuffer: FramebufferHandle;
        private pipeline1: GraphicsPipelineHandle;
        private pipeline2: GraphicsPipelineHandle;
        // The "bundle": the cities' draws, described once for the framebuffer.
        private bundle: DrawBatch;
        private constants: f32[];
        // The cities' model matrices (row vectors), set once.
        private modelMatrices: number[][];
        private camera: SimpleCamera;

        constructor(app: App) {
            this.app = app;
            this.bindingSets = [];
            this.hasTargets = false;
            this.constants = [];
            for (let i = 0; i < CITY_COUNT * CONSTANTS_STRIDE_FLOATS; i++) {
                this.constants.push(0.0);
            }
            this.modelMatrices = [];
            this.camera = new SimpleCamera();
        }

        init() {
            const shader = "bundles.hlsl";
            this.vertexShader = this.app.createShader(shader, "VSMain", ShaderType.Vertex);
            this.pixelShader = this.app.createShader(shader, "PSMain", ShaderType.Pixel);
            this.altPixelShader = this.app.createShader(shader, "PSAlt", ShaderType.Pixel);
            if (!this.vertexShader || !this.pixelShader || !this.altPixelShader) {
                return false;
            }
            const layoutDesc = InputLayoutDesc.create();
            // The vertex shader reads the positions and texture coordinates of the 44-byte vertices.
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_STRIDE);
            layoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 24, 0, VERTEX_STRIDE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vertexShader);

            // The sample's root signature: the texture's SRV, the sampler, the city's CBV.
            const bindingLayoutDesc = BindingLayoutDesc.create();
            bindingLayoutDesc.layoutConstantBuffer(0);
            bindingLayoutDesc.layoutTextureSRV(0);
            bindingLayoutDesc.layoutSampler(0);
            this.bindingLayout = this.app.createBindingLayout(bindingLayoutDesc, ShaderType.All);
            this.constantBuffer = this.app.createConstantBuffer(CITY_COUNT * CONSTANTS_STRIDE, "SceneConstantBuffers");

            // The sample's camera: 8 right, 8 up and 30 back, at SimpleCamera's speeds.
            this.camera.init(8.0, 8.0, 30.0);

            // Blitting creates Donut's common passes: before any command list is open.
            this.app.getCommonSampler(CommonSampler.LinearClamp);
            const commandList = this.app.createCommandList();
            commandList.open();
            const ok = this.loadAssets(commandList);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);
            if (!ok) {
                return false;
            }

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }

        onKey(key: int, scancode: int, action: int, mods: int): int {
            if (action != ACTION_PRESS && action != ACTION_RELEASE) {
                return 0;
            }
            return this.camera.onKey(key, action == ACTION_PRESS) ? 1 : 0;
        }

        // OnUpdate: the camera.
        onAnimate(elapsedSeconds: number) {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
            this.camera.update(Math.fround(elapsedSeconds));
        }

        onBackBufferResizing() {
            if (!this.hasTargets) {
                return;
            }
            this.app.releaseObject(this.bundle.handle);
            this.app.releaseResource(this.pipeline1);
            this.app.releaseResource(this.pipeline2);
            this.app.releaseResource(this.framebuffer);
            this.app.releaseResource(this.colorBuffer);
            this.app.releaseResource(this.depthBuffer);
            this.app.clearBindingCache();
            this.hasTargets = false;
        }

        // The sample's back buffer, depth buffer, pipeline states (no culling, the default blend
        // state (opaque) and depth state (less, writes), the two pixel shaders) and bundle
        // (FrameResource::PopulateCommandList: the pipeline state alternating from city to city).
        createTargets(width: int, height: int) {
            this.colorBuffer = this.app.createRenderTargetTexture(width, height, Format.RGBA8_UNORM, "ColorBuffer");
            this.depthBuffer = this.app.createRenderTargetTexture(width, height, Format.D32, "DepthBuffer");
            this.framebuffer = this.app.createFramebuffer(this.colorBuffer, this.depthBuffer);

            const desc1 = GraphicsPipelineDesc.create(this.vertexShader, this.pixelShader);
            desc1.setInputLayout(this.inputLayout);
            desc1.addBindingLayout(this.bindingLayout);
            desc1.setDepthState(1, 1, ComparisonFunc.Less);
            desc1.setDepthClip(1);
            desc1.setRasterState(CullMode.None, FillMode.Solid, 0);
            this.pipeline1 = this.app.createGraphicsPipelineFromDesc(desc1, this.framebuffer);
            const desc2 = GraphicsPipelineDesc.create(this.vertexShader, this.altPixelShader);
            desc2.setInputLayout(this.inputLayout);
            desc2.addBindingLayout(this.bindingLayout);
            desc2.setDepthState(1, 1, ComparisonFunc.Less);
            desc2.setDepthClip(1);
            desc2.setRasterState(CullMode.None, FillMode.Solid, 0);
            this.pipeline2 = this.app.createGraphicsPipelineFromDesc(desc2, this.framebuffer);

            this.bundle = this.app.createDrawBatch(this.pipeline1, this.framebuffer, this.vertexBuffer, this.indexBuffer);
            let usePipeline1 = true;
            for (let i = 0; i < CITY_COUNT; i++) {
                this.bundle.addDrawWithPipeline(usePipeline1 ? this.pipeline1 : this.pipeline2, this.bindingSets[i],
                    INDEX_DATA_SIZE / 4, 0, 0);
                usePipeline1 = !usePipeline1;
            }
            this.hasTargets = true;
        }

        // OnUpdate's UpdateConstantBuffers (each city's model-view-projection matrix) and
        // PopulateCommandList: clear, execute the bundle.
        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const commandList = frame.getCommandList();
            const width = frame.getWidth();
            const height = frame.getHeight();
            if (!this.hasTargets) {
                this.createTargets(width, height);
            }

            const view = this.camera.viewMatrix();
            const projection = matrixPerspectiveFovRH(Math.fround(0.8), Math.fround(width / height), 1.0, 1000.0);
            for (let i = 0; i < CITY_COUNT; i++) {
                // model * view * projection, as the sample multiplies them: (model * view) * projection.
                const mvp = matrixTranspose(matrixMultiply(matrixMultiply(this.modelMatrices[i], view), projection));
                for (let k = 0; k < 16; k++) {
                    this.constants[i * CONSTANTS_STRIDE_FLOATS + k] = mvp[k];
                }
            }
            commandList.writeBuffer(this.constantBuffer, Ref(this.constants[0]), CITY_COUNT * CONSTANTS_STRIDE);

            commandList.clearTextureFloat(this.colorBuffer, CLEAR_R, CLEAR_G, CLEAR_B, 1.0);
            commandList.clearDepth(this.depthBuffer, 1.0);
            this.bundle.execute(commandList);
            this.app.blitTexture(frame, this.colorBuffer);
        }

        // LoadAssets: the city's mesh and diffuse texture from the data file, the cities' binding
        // sets and positions (FrameResource::SetCityPositions; y raised a little per city against
        // z-fighting).
        loadAssets(commandList: CommandList) {
            const binaryFile = this.app.loadBinaryFile(DATA_FILE);
            if (binaryFile.isNull()) {
                console.log(`Cannot load ${DATA_FILE} (the sample's data: build with DIRECTX_GRAPHICS_SAMPLES_DIR set)`);
                return false;
            }
            this.vertexBuffer = this.app.createStaticBufferFromBinaryFile(commandList, binaryFile,
                VERTEX_DATA_OFFSET, VERTEX_DATA_SIZE, 0, "City");
            this.indexBuffer = this.app.createStaticBufferFromBinaryFile(commandList, binaryFile,
                INDEX_DATA_OFFSET, INDEX_DATA_SIZE, 1, "City");
            const diffuse = this.app.createTextureWithLevels(TEXTURE_SIZE, TEXTURE_SIZE, 1, Format.BC1_UNORM, "CityDiffuse");
            binaryFile.writeTextureLevelFromBinaryFile(commandList, diffuse, 0, 0, TEXTURE_PITCH);
            this.app.releaseObject(binaryFile.handle);
            if (!this.vertexBuffer || !this.indexBuffer) {
                return false;
            }

            // The sample's sampler: linear, wrapping.
            const sampler = this.app.getCommonSampler(CommonSampler.LinearWrap);
            for (let i = 0; i < CITY_COUNT; i++) {
                const setDesc = BindingSetDesc.create();
                setDesc.bindConstantBuffer(0, this.constantBuffer, i * CONSTANTS_STRIDE, CONSTANTS_STRIDE);
                setDesc.bindTextureSRV(0, diffuse);
                setDesc.bindSampler(0, sampler);
                this.bindingSets.push(this.app.createBindingSetForLayout(setDesc, this.bindingLayout));
            }

            for (let i = 0; i < CITY_ROW_COUNT; i++) {
                const cityOffsetZ = Math.fround(i * CITY_INTERVAL_Z);
                for (let j = 0; j < CITY_COLUMN_COUNT; j++) {
                    const cityOffsetX = Math.fround(j * CITY_INTERVAL_X);
                    const cityOffsetY = Math.fround(Math.fround(0.02) * (i * CITY_COLUMN_COUNT + j));
                    this.modelMatrices.push(matrixTranslation(cityOffsetX, cityOffsetY, cityOffsetZ));
                }
            }
            return true;
        }
    }

    // -test: checks the last frame. The sky (the frame's top row) is the clear color; the cities
    // cover a good part of the frame, in both pipelines' colors: the city's texture as it is, and
    // filtered (red and blue at a quarter: green dominating).
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
        const background = 0 | (51 << 8) | (102 << 16);
        for (let x = 0; x < width; x++) {
            const p = pixels[x] & 0xFFFFFF;
            if (p != background) {
                return `top row pixel ${x} is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not the clear color`;
            }
        }
        let covered = 0;
        let filtered = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i] & 0xFFFFFF;
            if (p == background) {
                continue;
            }
            covered++;
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (g > 2 * r + 8 && g > 2 * b + 8) {
                filtered++;
            }
        }
        const coverage = covered / (width * height);
        const filteredFraction = filtered / (width * height);
        console.log(`Coverage ${coverage}, filtered ${filteredFraction}`);
        if (coverage < 0.1) {
            return `the cities cover ${coverage} of the frame`;
        }
        if (filteredFraction < 0.05 || filteredFraction > coverage - 0.05) {
            return `${filteredFraction} of the frame is in the second pipeline's colors, of ${coverage} covered: not both pipelines`;
        }
        return "";
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("bundles");

        // -test [-testOutput <file>]: render a few frames without a window and check the last one
        // (see checkFrame).
        const args = new Args(argc, argv, TEST_FRAMES);
        args.parseArgs();

        // UNORM back buffers, as the sample's R8G8B8A8_UNORM.
        const options = AppOptions.UnormBackBuffer | args.options;

        // The sample's window.
        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        const pass = new BundlesPass(app);
        if (!pass.init()) {
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        let result = 0;
        if (args.test) {
            result = app.finishTest(checkFrame(app));
        }
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return Bundles.main(argc, argv);
}

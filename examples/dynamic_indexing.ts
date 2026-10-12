// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import {
    matrixMultiply, matrixPerspectiveFovRH, matrixTranslation, matrixTranspose,
} from "../core/directx_math";
import { SimpleCamera } from "../core/simple_camera";

namespace DynamicIndexing {
    const WINDOW_TITLE = "D3D12 Dynamic Indexing Sample";
    const DATA_FILE = "media/dynamic_indexing/occcity.bin";

    // GLFW values, as passed to the keyboard callback.
    const ACTION_PRESS = 1;
    const ACTION_RELEASE = 0;

    // The sample's cities: 15 rows of 8, each with a material texture of its own (a 64 x 64 slice of
    // a rainbow), 16 units apart.
    const CITY_ROW_COUNT = 15;
    const CITY_COLUMN_COUNT = 8;
    const CITY_MATERIAL_COUNT = CITY_ROW_COUNT * CITY_COLUMN_COUNT;
    const CITY_MATERIAL_TEXTURE_SIZE = 64;
    const CITY_SPACING_INTERVAL = 16.0;

    // occcity.h: the data file's parts. The city's diffuse texture (BC1, 1024 x 1024, its pitch
    // 2048 bytes) at 0; the vertices (position, normal, texture coordinates, tangent: 44 bytes)
    // and the 32-bit indices after it.
    const TEXTURE_SIZE = 1024;
    const TEXTURE_DATA_SIZE = 524288;
    const TEXTURE_PITCH = 2048;
    const VERTEX_STRIDE = 44;
    const VERTEX_DATA_OFFSET = 524288;
    const VERTEX_DATA_SIZE = 820248;
    const INDEX_DATA_OFFSET = 1344536;
    const INDEX_DATA_SIZE = 74568;

    // The push constants: the city's world-view-projection matrix (transposed) and its material
    // index (a float).
    const DRAW_CONSTANT_FLOATS = 17;

    // The sample's clear color, (0, 0.2, 0.4).
    const CLEAR_R = 0.0;
    const CLEAR_G = 0.2;
    const CLEAR_B = 0.4;

    // Test mode: the frames rendered, each 1/60 s.
    const TEST_FRAMES = 3;

    // DirectXMath's XMColorHSLToRGB, in float, for the saturation and lightness the sample uses (0.5,
    // 0.5): its q, p and hue-to-color steps (multiplies and adds without fusing, as its SSE2 path).
    function hue2Clr(p: number, q: number, h: number): number {
        const oneSixth = Math.fround(1.0 / 6.0);
        const twoThirds = Math.fround(2.0 / 3.0);
        let t = h;
        if (t < 0.0) {
            t = Math.fround(t + 1.0);
        }
        if (t > 1.0) {
            t = Math.fround(t - 1.0);
        }
        if (t < oneSixth) {
            return Math.fround(Math.fround(Math.fround(q - p) * Math.fround(6.0 * t)) + p);
        }
        if (t < 0.5) {
            return q;
        }
        if (t < twoThirds) {
            return Math.fround(Math.fround(Math.fround(q - p) * Math.fround(6.0 * Math.fround(twoThirds - t))) + p);
        }
        return p;
    }

    function hslToRgb(h: number, s: number, l: number): number[] {
        const oneThird = Math.fround(1.0 / 3.0);
        let q = 0.0;
        if (l < 0.5) {
            q = Math.fround(l * Math.fround(1.0 + s));
        } else {
            q = Math.fround(Math.fround(l + s) - Math.fround(l * s));
        }
        const p = Math.fround(Math.fround(2.0 * l) - q);
        return [hue2Clr(p, q, Math.fround(h + oneThird)), hue2Clr(p, q, h), hue2Clr(p, q, Math.fround(h - oneThird))];
    }

    // Port of DirectX-Graphics-Samples' D3D12DynamicIndexing: 120 copies of a city in 15 rows of 8,
    // drawn with one pipeline, each draw's pixel shader picking the city's material (a rainbow
    // slice) from an array of 120 textures by an index set per draw and modulating the city's
    // diffuse texture with it. The sample records the draws once into a bundle per frame resource;
    // here they are recorded each frame. The sample's back buffer (R8G8B8A8_UNORM) and D32_FLOAT
    // depth buffer are a color target here, blitted into the back buffer.
    class DynamicIndexingPass {
        private app: App;
        private vertexShader: ShaderHandle;
        private pixelShader: ShaderHandle;
        private inputLayout: InputLayoutHandle;
        private bindingLayout: BindingLayoutHandle;
        private bindingSet: BindingSet;
        private vertexBuffer: BufferHandle;
        private indexBuffer: BufferHandle;
        private indexCount: int;
        private hasTargets: boolean;
        private colorBuffer: TextureHandle;
        private depthBuffer: TextureHandle;
        private framebuffer: FramebufferHandle;
        private pipeline: GraphicsPipelineHandle;
        private drawConstants: f32[];
        // The cities' model matrices (row vectors), set once.
        private modelMatrices: number[][];
        private camera: SimpleCamera;

        constructor(app: App) {
            this.app = app;
            this.indexCount = 0;
            this.hasTargets = false;
            this.drawConstants = [];
            for (let i = 0; i < DRAW_CONSTANT_FLOATS; i++) {
                this.drawConstants.push(0.0);
            }
            this.modelMatrices = [];
            this.camera = new SimpleCamera();
        }

        onKey(key: int, scancode: int, action: int, mods: int): int {
            if (action != ACTION_PRESS && action != ACTION_RELEASE) {
                return 0;
            }
            return this.camera.onKey(key, action == ACTION_PRESS) ? 1 : 0;
        }

        // OnUpdate: the camera.
        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
            this.camera.update(Math.fround(elapsedSeconds));
        }

        onBackBufferResizing(): void {
            if (!this.hasTargets) {
                return;
            }
            this.app.releaseResource(this.pipeline);
            this.app.releaseResource(this.framebuffer);
            this.app.releaseResource(this.colorBuffer);
            this.app.releaseResource(this.depthBuffer);
            this.app.clearBindingCache();
            this.hasTargets = false;
        }

        // The sample's back buffer, depth buffer and pipeline state: no culling, the default blend
        // state (opaque) and depth state (less, writes).
        createTargets(width: int, height: int): void {
            this.colorBuffer = this.app.createRenderTargetTexture(width, height, Format.RGBA8_UNORM, "ColorBuffer");
            this.depthBuffer = this.app.createRenderTargetTexture(width, height, Format.D32, "DepthBuffer");
            this.framebuffer = this.app.createFramebuffer(this.colorBuffer, this.depthBuffer);

            const desc = GraphicsPipelineDesc.create(this.vertexShader, this.pixelShader);
            desc.setInputLayout(this.inputLayout);
            desc.addBindingLayout(this.bindingLayout);
            desc.setDepthState(1, 1, ComparisonFunc.Less);
            desc.setRasterState(CullMode.None, FillMode.Solid, 0);
            this.pipeline = this.app.createGraphicsPipelineFromDesc(desc, this.framebuffer);
            this.hasTargets = true;
        }

        // UpdateConstantBuffers and the bundle's draws: each city with its model-view-projection
        // matrix and material index.
        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const commandList = frame.getCommandList();
            const width = frame.getWidth();
            const height = frame.getHeight();
            if (!this.hasTargets) {
                this.createTargets(width, height);
            }

            commandList.clearTextureFloat(this.colorBuffer, CLEAR_R, CLEAR_G, CLEAR_B, 1.0);
            commandList.clearDepth(this.depthBuffer, 1.0);

            const view = this.camera.viewMatrix();
            const projection = matrixPerspectiveFovRH(Math.fround(0.8), Math.fround(width / height), 1.0, 1000.0);
            const viewProjection = matrixMultiply(view, projection);
            frame.beginDrawToFramebuffer(this.pipeline, this.framebuffer);
            frame.drawAddBindingSet(this.bindingSet);
            frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
            frame.drawSetIndexBuffer(this.indexBuffer);
            for (let i = 0; i < CITY_MATERIAL_COUNT; i++) {
                // model * view * projection, as the sample multiplies them: (model * view) * projection.
                const mvp = matrixTranspose(matrixMultiply(matrixMultiply(this.modelMatrices[i], view), projection));
                for (let k = 0; k < 16; k++) {
                    this.drawConstants[k] = mvp[k];
                }
                this.drawConstants[16] = i;
                frame.drawIndexedWithPushConstants(this.indexCount, Ref(this.drawConstants[0]), DRAW_CONSTANT_FLOATS * 4);
            }
            this.app.blitTexture(frame, this.colorBuffer);
        }

        // LoadAssets: the city's mesh and diffuse texture from the data file, the material textures
        // (rows of a rainbow: city i spans hues i / 120 to (i + 1) / 120 down its texture), and the
        // cities' positions (SetCityPositions; y raised a little per city against z-fighting).
        loadAssets(commandList: CommandList): boolean {
            const binaryFile = this.app.loadBinaryFile(DATA_FILE);
            if (binaryFile.isNull()) {
                console.log(`Cannot load ${DATA_FILE} (the sample's data: build with DIRECTX_GRAPHICS_SAMPLES_DIR set)`);
                return false;
            }
            let vertices: int[] = [];
            for (let i = 0; i < VERTEX_DATA_SIZE / 4; i++) {
                vertices.push(0);
            }
            binaryFile.copyUInts(VERTEX_DATA_OFFSET, VERTEX_DATA_SIZE / 4, Ref(vertices[0]));
            this.vertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(vertices[0]), VERTEX_DATA_SIZE, "City");
            let indices: int[] = [];
            for (let i = 0; i < INDEX_DATA_SIZE / 4; i++) {
                indices.push(0);
            }
            binaryFile.copyUInts(INDEX_DATA_OFFSET, INDEX_DATA_SIZE / 4, Ref(indices[0]));
            this.indexBuffer = this.app.createStaticIndexBuffer(commandList, Ref(indices[0]), INDEX_DATA_SIZE, "City");
            this.indexCount = INDEX_DATA_SIZE / 4;
            let texels: int[] = [];
            for (let i = 0; i < TEXTURE_DATA_SIZE / 4; i++) {
                texels.push(0);
            }
            binaryFile.copyUInts(0, TEXTURE_DATA_SIZE / 4, Ref(texels[0]));
            this.app.releaseObject(binaryFile.handle);
            const diffuse = this.app.createTextureWithLevels(TEXTURE_SIZE, TEXTURE_SIZE, 1, Format.BC1_UNORM, "CityDiffuse");
            commandList.writeTextureLevel(diffuse, 0, Ref(texels[0]), TEXTURE_PITCH);

            const setDesc = BindingSetDesc.create();
            setDesc.bindPushConstants(0, DRAW_CONSTANT_FLOATS * 4);
            setDesc.bindTextureSRV(0, diffuse);
            const step = Math.fround(1.0 / Math.fround(CITY_MATERIAL_COUNT));
            const size = CITY_MATERIAL_TEXTURE_SIZE;
            for (let i = 0; i < CITY_MATERIAL_COUNT; i++) {
                const t = Math.fround(i * step);
                let pixels: int[] = [];
                for (let y = 0; y < size; y++) {
                    const tPrime = Math.fround(t + Math.fround(Math.fround(Math.fround(y) / Math.fround(size)) * step));
                    const rgb = hslToRgb(tPrime, 0.5, 0.5);
                    // static_cast<unsigned char>(255 * c): truncated.
                    const r: int = Math.floor(Math.fround(255.0 * rgb[0]));
                    const g: int = Math.floor(Math.fround(255.0 * rgb[1]));
                    const b: int = Math.floor(Math.fround(255.0 * rgb[2]));
                    const pixel = r | (g << 8) | (b << 16) | (255 << 24);
                    for (let x = 0; x < size; x++) {
                        pixels.push(pixel);
                    }
                }
                const material = this.app.createTextureWithLevels(size, size, 1, Format.RGBA8_UNORM, "CityMaterial");
                commandList.writeTextureLevel(material, 0, Ref(pixels[0]), size * 4);
                setDesc.bindTextureSRVArrayElement(1, i, material);
            }
            // The sample's sampler: linear, wrapping.
            setDesc.bindSampler(0, this.app.getCommonSampler(CommonSampler.LinearWrap));
            this.bindingSet = this.app.createBindingSetForLayout(setDesc, this.bindingLayout);

            for (let i = 0; i < CITY_ROW_COUNT; i++) {
                const cityOffsetZ = Math.fround(i * -CITY_SPACING_INTERVAL);
                for (let j = 0; j < CITY_COLUMN_COUNT; j++) {
                    const cityOffsetX = Math.fround(j * CITY_SPACING_INTERVAL);
                    const cityOffsetY = Math.fround(Math.fround(0.02) * (i * CITY_COLUMN_COUNT + j));
                    this.modelMatrices.push(matrixTranslation(cityOffsetX, cityOffsetY, cityOffsetZ));
                }
            }
            return true;
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const shader = "dynamic_indexing.hlsl";
            this.vertexShader = this.app.createShader(shader, "VSMain", ShaderType.Vertex);
            this.pixelShader = this.app.createShader(shader, "PSMain", ShaderType.Pixel);
            if (!this.vertexShader || !this.pixelShader) {
                return false;
            }
            const layoutDesc = InputLayoutDesc.create();
            // The vertex shader reads the positions and texture coordinates of the 44-byte vertices.
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_STRIDE);
            layoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 24, 0, VERTEX_STRIDE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vertexShader);

            // The sample's root signature: the materials' SRVs (t0, and t1 onwards), the sampler,
            // the city's CBV and the material index (one block of push constants here).
            const bindingLayoutDesc = BindingLayoutDesc.create();
            bindingLayoutDesc.layoutPushConstants(0, DRAW_CONSTANT_FLOATS * 4);
            bindingLayoutDesc.layoutTextureSRV(0);
            bindingLayoutDesc.layoutTextureSRVArray(1, CITY_MATERIAL_COUNT);
            bindingLayoutDesc.layoutSampler(0);
            this.bindingLayout = this.app.createBindingLayout(bindingLayoutDesc, ShaderType.All);

            // The sample's camera: over the middle of the first row's cities, 15 up and 50 back,
            // twice the city spacing a second.
            this.camera.init(Math.fround(Math.fround(CITY_COLUMN_COUNT / 2.0) * CITY_SPACING_INTERVAL - CITY_SPACING_INTERVAL / 2.0), 15.0, 50.0);
            this.camera.setMoveSpeed(CITY_SPACING_INTERVAL * 2.0);

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
    }

    // -test: checks the last frame. The sky (the frame's top row) is the clear color; the cities
    // cover a good part of the frame, each in its own color: their pixels spread over many hues.
    function checkFrame(app: App): string {
        const width = app.getWindowWidth();
        const height = app.getWindowHeight();
        let pixels: int[] = [];
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
        // Covered pixels by which channel dominates: red, green, blue, or two of them.
        let covered = 0;
        let hues: int[] = [0, 0, 0, 0, 0, 0];
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i] & 0xFFFFFF;
            if (p == background) {
                continue;
            }
            covered++;
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r > g + 20 && r > b + 20) {
                hues[0]++;
            } else if (g > r + 20 && g > b + 20) {
                hues[1]++;
            } else if (b > r + 20 && b > g + 20) {
                hues[2]++;
            } else if (r > b + 20 && g > b + 20) {
                hues[3]++;
            } else if (g > r + 20 && b > r + 20) {
                hues[4]++;
            } else if (r > g + 20 && b > g + 20) {
                hues[5]++;
            }
        }
        let huesShown = 0;
        for (let k = 0; k < 6; k++) {
            if (hues[k] > 500) {
                huesShown++;
            }
        }
        const coverage = covered / (width * height);
        console.log(`Coverage ${coverage}; reddish ${hues[0]}, greenish ${hues[1]}, bluish ${hues[2]}, yellowish ${hues[3]}, cyan ${hues[4]}, magenta ${hues[5]}`);
        if (coverage < 0.2) {
            return `the cities cover ${coverage} of the frame`;
        }
        if (huesShown < 5) {
            return `the cities show ${huesShown} of 6 hue families, not 5 or more`;
        }
        return "";
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("dynamic_indexing");

        // -test [-testOutput <file>]: render a few frames without a window and check the last one
        // (see checkFrame).
        const args = new Args();
        args.parseArgs(argc, argv, TEST_FRAMES);

        // UNORM back buffers, as the sample's R8G8B8A8_UNORM.
        const options = AppOptions.UnormBackBuffer | args.options;

        // The sample's window.
        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        const pass = new DynamicIndexingPass(app);
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
function main(argc: int, argv: Ref<string>): int {
    return DynamicIndexing.main(argc, argv);
}

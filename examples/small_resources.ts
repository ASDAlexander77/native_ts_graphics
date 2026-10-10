// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace SmallResources {
    const WINDOW_TITLE = "D3D12 Small Resources Sample";

    const KEY_SPACE = 32;
    const ACTION_PRESS = 1;

    // The sample's grid of textures, each 32 x 32 RGBA8.
    const GRID_WIDTH = 11;
    const GRID_HEIGHT = 7;
    const TEXTURE_COUNT = GRID_WIDTH * GRID_HEIGHT;
    const TEXTURE_WIDTH = 32;
    const TEXTURE_HEIGHT = 32;
    const TEXTURE_PIXEL_SIZE = 4;
    // The sample's vertex: position, texture coordinates.
    const VERTEX_STRIDE = 20;
    const MB = 1048576.0;
    const KB = 1024.0;

    // MSVC's rand(), which the sample's colors come from (srand(100) before each set).
    class MsvcRandom {
        private state: number;

        constructor(seed: number) {
            this.state = seed;
        }

        next(): int {
            this.state = (this.state * 214013 + 2531011) % 4294967296;
            const value: int = Math.floor(this.state / 65536) % 32768;
            return value;
        }
    }

    // FormatMemoryUsage.
    function formatMemoryUsage(usage: number): string {
        if (usage > MB) {
            return `${Math.fround(usage / MB).toFixed(1)} MB`;
        }
        if (usage > KB) {
            return `${Math.fround(usage / KB).toFixed(1)} KB`;
        }
        return `${usage} B`;
    }

    // Port of DirectX-Graphics-Samples' D3D12SmallResources: 77 small (32 x 32) checkerboard
    // textures drawn in a grid, either placed in one heap at D3D12's 4 KB small resource alignment
    // (Vulkan: its own memory requirements) or created as committed resources (64 KB each on D3D12);
    // Space switches between the two, the window title shows the resource type and the GPU memory in
    // use.
    class SmallResourcesPass {
        private app: App;
        private bindingLayout: BindingLayoutHandle;
        private pipeline: GraphicsPipelineHandle;
        private hasPipeline: boolean;
        private vertexShader: ShaderHandle;
        private pixelShader: ShaderHandle;
        private inputLayout: InputLayoutHandle;
        private vertexBuffer: BufferHandle;
        private sampler: SamplerHandle;
        private textures: TextureHandle[];
        private bindingSets: BindingSet[];
        private textureHeap: Opaque;
        private hasTextureHeap: boolean;
        private recreate: boolean;

        usePlacedResources: boolean;

        constructor(app: App) {
            this.app = app;
            this.hasPipeline = false;
            this.textures = [];
            this.bindingSets = [];
            this.hasTextureHeap = false;
            this.recreate = false;
            this.usePlacedResources = true;
        }

        onKey(key: int, scancode: int, action: int, mods: int): int {
            if (key == KEY_SPACE && action == ACTION_PRESS) {
                this.usePlacedResources = !this.usePlacedResources;
                this.recreate = true;
            }
            return 0;
        }

        // The textures, outside a frame: after the GPU is done with the old ones.
        onAnimate(elapsedSeconds: number): void {
            if (this.recreate) {
                Donut_WaitForIdle(this.app.handle);
                this.createTextures();
                this.recreate = false;
            }

            // OnRender's title: the resource type and the local (video) memory in use.
            let usage = 0.0;
            const heaps = this.app.queryMemoryBudget();
            for (let i = 0; i < heaps; i++) {
                if ((this.app.getMemoryHeapFlags(i) & MemoryHeapFlag.DeviceLocal) != 0) {
                    usage = this.app.getMemoryHeapUsage(i);
                    break;
                }
            }
            let type = "Committed";
            if (this.usePlacedResources) {
                type = "Placed";
            }
            Donut_SetWindowTitle(this.app.handle, `${WINDOW_TITLE}: [ResourceType: ${type}] - Memory Used: ${formatMemoryUsage(usage)}`);
        }

        releaseTextures(): void {
            for (let i = 0; i < this.bindingSets.length; i++) {
                this.app.releaseResource(this.bindingSets[i].handle);
            }
            for (let i = 0; i < this.textures.length; i++) {
                this.app.releaseResource(this.textures[i]);
            }
            this.bindingSets = [];
            this.textures = [];
            if (this.hasTextureHeap) {
                this.app.releaseObject(this.textureHeap);
                this.hasTextureHeap = false;
            }
        }

        // GenerateTexture: a checkerboard of 8 x 8 cells, black and a random color.
        generateTexture(random: MsvcRandom): int[] {
            const r = random.next() & 0xff;
            const g = random.next() & 0xff;
            const b = random.next() & 0xff;
            const color = r | (g << 8) | (b << 16) | (0xff << 24);
            const black = 0xff << 24;
            let data: int[] = [];
            for (let y = 0; y < TEXTURE_HEIGHT; y++) {
                for (let x = 0; x < TEXTURE_WIDTH; x++) {
                    // The sample's cells: 16 bytes (4 pixels) wide, 4 rows high.
                    const i = Math.floor(x / 4);
                    const j = Math.floor(y / 4);
                    if (i % 2 == j % 2) {
                        data.push(black);
                    } else {
                        data.push(color);
                    }
                }
            }
            return data;
        }

        // CreateTextures: placed in one heap, or committed.
        createTextures(): void {
            this.releaseTextures();
            const commandList = this.app.createCommandList();
            commandList.open();
            let placedSize = 0.0;
            if (this.usePlacedResources) {
                placedSize = this.app.getPlacedTextureSize(TEXTURE_WIDTH, TEXTURE_HEIGHT, Format.RGBA8_UNORM);
                const heap = this.app.createTextureHeap(TEXTURE_COUNT * placedSize, "Texture Heap");
                if (heap) {
                    this.textureHeap = heap as Opaque;
                    this.hasTextureHeap = true;
                }
            }

            // Colors are random, the same for both kinds of resources.
            const random = new MsvcRandom(100);
            for (let n = 0; n < TEXTURE_COUNT; n++) {
                const name = `Texture${n}`;
                const texture: TextureHandle = this.hasTextureHeap
                    ? this.app.createPlacedTexture(commandList, this.textureHeap, n * placedSize, TEXTURE_WIDTH, TEXTURE_HEIGHT,
                        Format.RGBA8_UNORM, name) as TextureHandle
                    : this.app.createTextureWithLevels(TEXTURE_WIDTH, TEXTURE_HEIGHT, 1, Format.RGBA8_UNORM, name);
                const data = this.generateTexture(random);
                commandList.writeTextureLevel(texture, 0, Ref(data[0]), TEXTURE_WIDTH * TEXTURE_PIXEL_SIZE);
                this.textures.push(texture);

                const setDesc = BindingSetDesc.create();
                setDesc.bindTextureSRV(0, texture);
                setDesc.bindSampler(0, this.sampler);
                this.bindingSets.push(this.app.createBindingSetForLayout(setDesc, this.bindingLayout));
            }
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);
        }

        // PopulateCommandList: the grid, a quad (triangle strip) per texture.
        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            if (!this.hasPipeline) {
                const desc = GraphicsPipelineDesc.create(this.vertexShader, this.pixelShader);
                desc.setInputLayout(this.inputLayout);
                desc.addBindingLayout(this.bindingLayout);
                desc.setPrimitiveType(PrimitiveType.TriangleStrip);
                desc.setDepthState(0, 0, ComparisonFunc.Always);
                this.pipeline = this.app.createGraphicsPipelineFromDescForFrame(desc, frame);
                this.hasPipeline = true;
            }
            frame.clearColor(0.0, 0.2, 0.4, 1.0);
            for (let n = 0; n < this.textures.length; n++) {
                frame.beginDraw(this.pipeline);
                frame.drawAddBindingSet(this.bindingSets[n]);
                frame.drawAddVertexBuffer(this.vertexBuffer, 0, n * 4 * VERTEX_STRIDE);
                frame.drawVertices(4);
            }
        }

        onBackBufferResizing(): void {
            if (this.hasPipeline) {
                this.app.releaseResource(this.pipeline);
                this.hasPipeline = false;
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            // The sample's static sampler: linear, wrapping. Before any command list is open: it
            // creates Donut's common passes.
            this.sampler = this.app.getCommonSampler(CommonSampler.LinearWrap);

            this.vertexShader = this.app.createShader("small_resources.hlsl", "VSMain", ShaderType.Vertex);
            this.pixelShader = this.app.createShader("small_resources.hlsl", "PSMain", ShaderType.Pixel);
            if (!this.vertexShader || !this.pixelShader) {
                return false;
            }
            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_STRIDE);
            layoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 12, 0, VERTEX_STRIDE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vertexShader);
            const bindingLayoutDesc = BindingLayoutDesc.create();
            bindingLayoutDesc.layoutTextureSRV(0);
            bindingLayoutDesc.layoutSampler(0);
            this.bindingLayout = this.app.createBindingLayout(bindingLayoutDesc, ShaderType.Pixel);

            // LoadAssets: a quad per texture, on a grid centered on the screen (the window's aspect
            // ratio applied to y), in float as the sample's.
            const aspectRatio = Math.fround(1280.0 / 720.0);
            const offsetX = Math.fround(0.15);
            const marginX = Math.fround(offsetX / 10.0);
            const startX = Math.fround(Math.fround(Math.fround(GRID_WIDTH / 2.0) * -Math.fround(offsetX + marginX)) + Math.fround(marginX / 2.0));
            const offsetY = Math.fround(offsetX * aspectRatio);
            const marginY = Math.fround(offsetY / 10.0);
            let y = Math.fround(Math.fround(Math.fround(GRID_HEIGHT / 2.0) * Math.fround(offsetY + marginY)) - Math.fround(marginY / 2.0));
            let vertices: f32[] = [];
            for (let row = 0; row < GRID_HEIGHT; row++) {
                let x = startX;
                for (let column = 0; column < GRID_WIDTH; column++) {
                    const right = Math.fround(x + offsetX);
                    const bottom = Math.fround(y - offsetY);
                    const quad: number[] = [
                        x, bottom, 0.0, 0.0, 0.0,
                        x, y, 0.0, 0.0, 1.0,
                        right, bottom, 0.0, 1.0, 0.0,
                        right, y, 0.0, 1.0, 1.0,
                    ];
                    for (let i = 0; i < quad.length; i++) {
                        vertices.push(quad[i]);
                    }
                    x = Math.fround(x + Math.fround(offsetX + marginX));
                }
                y = Math.fround(y - Math.fround(offsetY + marginY));
            }
            const commandList = this.app.createCommandList();
            commandList.open();
            this.vertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(vertices[0]), vertices.length * 4, "Quads");
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);

            this.createTextures();

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("small_resources");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -committed: start with committed resources (the sample starts with placed ones).
        // UNORM back buffers, as the sample's R8G8B8A8_UNORM.
        let options = AppOptions.UnormBackBuffer;
        let committed = false;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = options | AppOptions.DebugRuntime;
            } else if (arg == "-committed") {
                committed = true;
            }
        }

        // The sample's window. Placed textures need D3D12 or Vulkan.
        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        console.log(`Renderer: ${app.getRendererString()}, a placed 32 x 32 RGBA8 texture takes ${app.getPlacedTextureSize(TEXTURE_WIDTH, TEXTURE_HEIGHT, Format.RGBA8_UNORM)} bytes`);

        const pass = new SmallResourcesPass(app);
        pass.usePlacedResources = !committed;
        if (!pass.init()) {
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        app.destroy();
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return SmallResources.main(argc, argv);
}

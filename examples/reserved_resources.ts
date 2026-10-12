// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";

namespace ReservedResources {
    const WINDOW_TITLE = "D3D12 Reserved resources sample - Use arrow keys to cycle through resources";

    const KEY_RIGHT = 262;
    const KEY_LEFT = 263;
    const KEY_DOWN = 264;
    const KEY_UP = 265;
    const ACTION_PRESS = 1;
    const ACTION_REPEAT = 2;

    // The sample's reserved texture: 256 x 256 RGBA8, a full mip chain.
    const TEXTURE_WIDTH = 256;
    const TEXTURE_HEIGHT = 256;
    const TEXTURE_PIXEL_SIZE = 4;
    // D3D12_TILED_RESOURCE_TILE_SIZE_IN_BYTES (Vulkan's sparse block of RGBA8 too).
    const TILE_SIZE = 65536;
    // The sample's vertex: position, texture coordinates.
    const VERTEX_STRIDE = 20;

    // Test mode: the frames rendered, each 1/60 s; one level a frame from the last one to the
    // level of -mip.
    const TEST_FRAMES = 12;

    // MipInfo: a level's heap (each whole-tile level has its own, the packed levels share the last
    // one), whether it's in the mip tail, whether its tiles are mapped (for the packed levels: the
    // first one's flag), and its size in tiles.
    class MipInfo {
        heapIndex: int;
        packedMip: boolean;
        mapped: boolean;
        widthInTiles: int;
        heightInTiles: int;

        constructor() {
            this.heapIndex = 0;
            this.packedMip = false;
            this.mapped = false;
            this.widthInTiles = 0;
            this.heightInTiles = 0;
        }
    }

    // GenerateTextureData for one level: a red and white checkerboard of 8 x 8 cells (cells at
    // least a pixel wide and high), as RGBA8 pixels.
    function generateTextureLevel(mip: int): int[] {
        const width = TEXTURE_WIDTH >> mip;
        const height = TEXTURE_HEIGHT >> mip;
        const rowPitch = width * TEXTURE_PIXEL_SIZE;
        // The width of a cell in bytes, as the sample's.
        let cellPitch = rowPitch >> 3;
        if (cellPitch < TEXTURE_PIXEL_SIZE) {
            cellPitch = TEXTURE_PIXEL_SIZE;
        }
        let cellHeight = height >> 3;
        if (cellHeight < 1) {
            cellHeight = 1;
        }
        const red = 0xff | (0xff << 24);
        const white = 0xff | (0xff << 8) | (0xff << 16) | (0xff << 24);
        let data: int[] = [];
        for (let y = 0; y < height; y++) {
            const j = Math.floor(y / cellHeight);
            for (let x = 0; x < width; x++) {
                const i = Math.floor(x * TEXTURE_PIXEL_SIZE / cellPitch);
                if (i % 2 == j % 2) {
                    data.push(red);
                } else {
                    data.push(white);
                }
            }
        }
        return data;
    }

    // Port of DirectX-Graphics-Samples' D3D12ReservedResources: a quad sampling one level of a
    // reserved (tiled) texture, the arrow keys picking the level. Only the level shown has memory:
    // when the level changes, its tiles are mapped to its heap (all the packed levels of the mip
    // tail at once, to theirs), the previous level's tiles are unmapped, and the new level's
    // checkerboard is uploaded. The window title shows the level.
    class ReservedResourcesPass {
        private app: App;
        private bindingLayout: BindingLayoutHandle;
        private bindingSet: BindingSet;
        private pipeline: GraphicsPipelineHandle;
        private hasPipeline: boolean;
        private vertexShader: ShaderHandle;
        private pixelShader: ShaderHandle;
        private inputLayout: InputLayoutHandle;
        private vertexBuffer: BufferHandle;
        private sampler: SamplerHandle;
        private texture: TextureHandle;
        private heaps: HeapHandle[];
        private mips: MipInfo[];
        private numStandardMips: int;
        private numPackedMips: int;
        private packedMipTiles: int;
        private activeMipChanged: boolean;
        private rootConstants: f32[];

        activeMip: int;
        // Test mode: the level the run steps to, one level a frame (-1: none).
        testTargetMip: int;

        constructor(app: App) {
            this.app = app;
            this.hasPipeline = false;
            this.heaps = [];
            this.mips = [];
            this.numStandardMips = 0;
            this.numPackedMips = 0;
            this.packedMipTiles = 0;
            this.activeMip = 0;
            this.activeMipChanged = true;
            this.testTargetMip = -1;
            this.rootConstants = [0.0];
        }

        mipCount(): int {
            return this.mips.length;
        }

        onKey(key: int, scancode: int, action: int, mods: int): int {
            if (action != ACTION_PRESS && action != ACTION_REPEAT) {
                return 0;
            }
            if (key == KEY_LEFT || key == KEY_UP) {
                if (this.activeMip != 0) {
                    this.activeMip--;
                    this.activeMipChanged = true;
                }
            } else if (key == KEY_RIGHT || key == KEY_DOWN) {
                if (this.activeMip < this.mips.length - 1) {
                    this.activeMip++;
                    this.activeMipChanged = true;
                }
            }
            return 0;
        }

        // UpdateTileMapping: if the active level's tiles aren't mapped yet, maps them and unmaps the
        // previously mapped level's, then uploads the level (all the packed levels if it is one of
        // them). Outside the frame: the sample remaps on the queue before the frame's command list,
        // whose copy writes the level.
        updateTileMapping(): void {
            const firstSubresource = this.mips[this.activeMip].heapIndex;
            let subresourceCount = 1;
            if (this.mips[this.activeMip].packedMip) {
                subresourceCount = this.numPackedMips;
            }

            if (!this.mips[firstSubresource].mapped) {
                const mappings = TileMappings.create();
                for (let n = 0; n < this.heaps.length; n++) {
                    if (!this.mips[n].mapped && n != firstSubresource) {
                        // Skip unchanged tile regions.
                        continue;
                    }
                    // The active level's tiles to its heap, the previous level's to none.
                    const map = n == firstSubresource;
                    const mip = this.mips[n];
                    if (mip.packedMip) {
                        mappings.addPackedMips(n, this.packedMipTiles, map ? this.heaps[n] : null, 0.0);
                    } else {
                        for (let y = 0; y < mip.heightInTiles; y++) {
                            for (let x = 0; x < mip.widthInTiles; x++) {
                                mappings.add(n, x, y, map ? this.heaps[n] : null, (y * mip.widthInTiles + x) * TILE_SIZE);
                            }
                        }
                    }
                    mip.mapped = map;
                }
                this.app.applyTileMappings(this.texture, mappings);

                // Upload the level(s) to the reserved texture.
                const commandList = this.app.createCommandList();
                commandList.open();
                for (let n = 0; n < subresourceCount; n++) {
                    const mip = firstSubresource + n;
                    const data = generateTextureLevel(mip);
                    commandList.writeTextureLevel(this.texture, mip, Ref(data[0]), (TEXTURE_WIDTH >> mip) * TEXTURE_PIXEL_SIZE);
                }
                commandList.close();
                this.app.executeCommandList(commandList);
                this.app.releaseResource(commandList.handle);
            }

            this.activeMipChanged = false;
            Donut_SetWindowTitle(this.app.handle, `${WINDOW_TITLE}: Mip Level: ${this.activeMip}`);
        }

        onAnimate(elapsedSeconds: number): void {
            if (this.testTargetMip >= 0) {
                if (this.activeMip > this.testTargetMip) {
                    this.activeMip--;
                    this.activeMipChanged = true;
                } else if (this.activeMip < this.testTargetMip) {
                    this.activeMip++;
                    this.activeMipChanged = true;
                }
            }
            if (this.activeMipChanged) {
                this.updateTileMapping();
            }
        }

        // PopulateCommandList: the quad (a triangle strip) sampling the active level.
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
            this.rootConstants[0] = this.activeMip;
            frame.beginDraw(this.pipeline);
            frame.drawAddBindingSet(this.bindingSet);
            frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
            frame.drawVerticesWithPushConstants(4, Ref(this.rootConstants[0]), 4);
        }

        onBackBufferResizing(): void {
            if (this.hasPipeline) {
                this.app.releaseResource(this.pipeline);
                this.hasPipeline = false;
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            // The sample's static sampler: linear, a transparent black border. Before any command
            // list is open: it creates Donut's common passes.
            this.sampler = this.app.createBorderSampler(1, 1, 1, 0.0, 0.0, 0.0, 0.0);

            this.vertexShader = this.app.createShader("reserved_resources.hlsl", "VSMain", ShaderType.Vertex);
            this.pixelShader = this.app.createShader("reserved_resources.hlsl", "PSMain", ShaderType.Pixel);
            if (!this.vertexShader || !this.pixelShader) {
                return false;
            }
            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_STRIDE);
            layoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 12, 0, VERTEX_STRIDE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vertexShader);
            const bindingLayoutDesc = BindingLayoutDesc.create();
            bindingLayoutDesc.layoutPushConstants(0, 4);
            bindingLayoutDesc.layoutTextureSRV(0);
            bindingLayoutDesc.layoutSampler(0);
            this.bindingLayout = this.app.createBindingLayout(bindingLayoutDesc, ShaderType.All);

            // LoadAssets: the quad, its height scaled by the window's aspect ratio (in float, as
            // the sample's).
            const aspectRatio = Math.fround(1280.0 / 720.0);
            const y = Math.fround(0.25 * aspectRatio);
            const vertices: number[] = [
                -0.25, -y, 0.0, 0.0, 1.0,   // Bottom left.
                -0.25, y, 0.0, 0.0, 0.0,    // Top left.
                0.25, -y, 0.0, 1.0, 1.0,    // Bottom right.
                0.25, y, 0.0, 1.0, 0.0,     // Top right.
            ];
            let floats: f32[] = [];
            for (let i = 0; i < vertices.length; i++) {
                floats.push(vertices[i]);
            }
            const commandList = this.app.createCommandList();
            commandList.open();
            this.vertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(floats[0]), floats.length * 4, "Quad");
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);

            // The reserved texture: no memory behind it until tiles are mapped.
            let mipLevels = 0;
            let w = TEXTURE_WIDTH;
            let h = TEXTURE_HEIGHT;
            while (w > 0 && h > 0) {
                mipLevels++;
                w = w >> 1;
                h = h >> 1;
            }
            this.texture = this.app.createTiledTexture(TEXTURE_WIDTH, TEXTURE_HEIGHT, mipLevels, Format.RGBA8_UNORM, "Reserved Texture");

            // Its tiling (GetResourceTiling: driver dependent): the tile's size, the levels of
            // whole tiles, and the packed ones after them.
            let tiling: int[] = [0, 0, 0, 0];
            this.app.getTextureTiling(this.texture, Ref(tiling[0]));
            const tileWidth = tiling[0];
            const tileHeight = tiling[1];
            this.numStandardMips = tiling[2];
            this.numPackedMips = tiling[3];
            this.packedMipTiles = this.app.getTexturePackedMipTileCount(this.texture);
            console.log(`Tiles of ${tileWidth} x ${tileHeight} texels, ${this.numStandardMips} levels of whole tiles, ${this.numPackedMips} packed levels in ${this.packedMipTiles} tile(s)`);

            let heapCount = this.numStandardMips;
            if (this.numPackedMips > 0) {
                heapCount++;
            }
            for (let n = 0; n < mipLevels; n++) {
                const mip = new MipInfo();
                if (n < this.numStandardMips) {
                    mip.heapIndex = n;
                    mip.widthInTiles = Math.floor(((TEXTURE_WIDTH >> n) + tileWidth - 1) / tileWidth);
                    mip.heightInTiles = Math.floor(((TEXTURE_HEIGHT >> n) + tileHeight - 1) / tileHeight);
                } else {
                    // All of the packed levels go into the last heap.
                    mip.heapIndex = heapCount - 1;
                    mip.packedMip = true;
                }
                this.mips.push(mip);
            }

            // A heap per level of whole tiles, one for the packed levels: the sample's
            // illustration of mapping tiles from several heaps into one reserved resource.
            for (let n = 0; n < heapCount; n++) {
                let tiles = this.packedMipTiles;
                if (n < this.numStandardMips) {
                    tiles = this.mips[n].widthInTiles * this.mips[n].heightInTiles;
                }
                this.heaps.push(this.app.createTileHeap(tiles * TILE_SIZE, `Heap ${n}`));
            }

            // Show the least detailed level first.
            this.activeMip = mipLevels - 1;
            this.updateTileMapping();

            const setDesc = BindingSetDesc.create();
            setDesc.bindPushConstants(0, 4);
            setDesc.bindTextureSRV(0, this.texture);
            setDesc.bindSampler(0, this.sampler);
            this.bindingSet = this.app.createBindingSetForLayout(setDesc, this.bindingLayout);

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }

        destroy(): void {
            Donut_WaitForIdle(this.app.handle);
            this.app.releaseResource(this.texture);
            for (let n = 0; n < this.heaps.length; n++) {
                this.app.releaseResource(this.heaps[n]);
            }
        }
    }

    // -test: checks the last frame, the level of -mip (0 by default) after one level a frame from
    // the last one, through every mapping change. The frame's corners are the clear color; at the
    // centers of the quad's 8 x 8 cells the checkerboard's red and white, red in the top left cell
    // (levels of 16 texels or more: a cell's center is between texels of its own color, which
    // linear filtering keeps pure).
    function checkFrame(app: App, mip: int): string {
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
        const corners: int[] = [0, width - 1, (height - 1) * width, height * width - 1];
        for (let i = 0; i < corners.length; i++) {
            const p = pixels[corners[i]] & 0xFFFFFF;
            if (p != background) {
                return `corner pixel ${corners[i]} is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not the clear color`;
            }
        }
        if ((TEXTURE_WIDTH >> mip) < 16) {
            return "";
        }
        // The quad: x in [-0.25, 0.25], y in [-0.25, 0.25] * aspect ratio (a square here).
        const quadWidth = width * 0.25;
        const quadHeight = height * 0.25 * (1280.0 / 720.0);
        const left = (width - quadWidth) * 0.5;
        const top = (height - quadHeight) * 0.5;
        const red = 0xff;
        const white = 0xFFFFFF;
        for (let j = 0; j < 8; j++) {
            for (let i = 0; i < 8; i++) {
                const x = Math.floor(left + (i + 0.5) * quadWidth / 8);
                const y = Math.floor(top + (j + 0.5) * quadHeight / 8);
                const p = pixels[y * width + x] & 0xFFFFFF;
                let expected = white;
                if (i % 2 == j % 2) {
                    expected = red;
                }
                if (p != expected) {
                    return `cell ${i}, ${j} (pixel ${x}, ${y}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not the checkerboard's`;
                }
            }
        }
        return "";
    }

    class ReservedResourcesArgs extends Args {
        // -mip <level>: the level the test steps to.
        testMip = 0;

        constructor(argc: int, argv: Ref<string>, testFrames: int) {
            super(argc, argv, testFrames);
        }

        protected parseOptions(): void {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-mip" && i + 1 < this.argc) {
                    this.testMip = parseInt(this[i + 1]);
                    i++;
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("reserved_resources");

        // -test [-testOutput <file>]: render a few frames without a window and check the last one
        // (see checkFrame).
        const args = new ReservedResourcesArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        // The sample's window. Reserved resources need D3D12 (tiled resources) or Vulkan (sparse
        // residency). UNORM back buffers, as the sample's R8G8B8A8_UNORM.
        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, AppOptions.UnormBackBuffer | args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        if (app.hasSparseResidency() == 0) {
            console.log("Reserved resources are not supported by your GPU.");
            app.destroy();
            return 1;
        }

        const pass = new ReservedResourcesPass(app);
        if (!pass.init()) {
            app.destroy();
            return 1;
        }
        if (args.test) {
            if (args.testMip < 0 || args.testMip >= pass.mipCount()) {
                console.log(`-mip ${args.testMip}: the texture has levels 0 to ${pass.mipCount() - 1}`);
                app.destroy();
                return 1;
            }
            pass.testTargetMip = args.testMip;
        }

        const input = new InputPass(app.handle);

        app.run();
        let result = 0;
        if (args.test) {
            result = app.finishTest(checkFrame(app, args.testMip));
        }
        pass.destroy();
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return ReservedResources.main(argc, argv);
}

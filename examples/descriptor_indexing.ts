// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace DescriptorIndexing {
    const WINDOW_TITLE = "Donut Example: Descriptor Indexing";

    // The streamed table's slots (the sample's NumDescriptorsStreaming), and the textures, one per
    // quad of each grid (NumDescriptorsNonUniform).
    const NUM_DESCRIPTORS_STREAMING = 2048;
    const NUM_DESCRIPTORS_NON_UNIFORM = 64;
    const IMAGE_SIZE = 16;

    // The push constants: float phase; uint table_offset; uint instance.
    const PUSH_SIZE = 12;

    // The render pass's clear color.
    const CLEAR_COLOR = [0.033, 0.073, 0.133];

    // --- The sample's test images ---------------------------------------------------------------

    // float_to_unorm8: v * 255 rounded (half up), clamped, in float as the sample computes it (its
    // truncation is a floor here: the two differ only below 0, clamped either way).
    function floatToUnorm8(v: number): int {
        const rounded = Math.floor(Math.fround(Math.fround(v * 255.0) + 0.5));
        return Math.min(Math.max(rounded, 0), 255);
    }

    // The sample's create_image: 16 x 16 RGBA8, a pattern picked by the seed (a checkerboard,
    // stripes or diagonals of 4-texel cells) in the color, the dark cells at a quarter, each
    // channel plus noise in [0, 0.1) from the sample's random engine; packed 4 bytes per int.
    function createImageData(rgb: number[], imageSeed: int, rng: Opaque): int[] {
        let texels: int[] = [];
        for (let y = 0; y < IMAGE_SIZE; y++) {
            for (let x = 0; x < IMAGE_SIZE; x++) {
                let pattern = 0;
                const kind = imageSeed & 3;
                if (kind == 1) {
                    pattern = (x >> 2) & 1;
                } else if (kind == 2) {
                    pattern = (y >> 2) & 1;
                } else if (kind == 3) {
                    pattern = ((x + y) >> 2) & 1;
                } else {
                    pattern = ((x >> 2) ^ (y >> 2)) & 1;
                }
                const patternColor = pattern != 0 ? 0.25 : 1.0;
                let texel = 0;
                for (let i = 0; i < 3; i++) {
                    const noise = Donut_RandomUniformFloat(rng, 0.0, 0.1);
                    texel |= floatToUnorm8(Math.fround(Math.fround(patternColor * rgb[i]) + noise)) << (i * 8);
                }
                // Alpha 0xff.
                texel |= 255 << 24;
                texels.push(texel);
            }
        }
        return texels;
    }

    // --- Pass -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' descriptor_indexing: two grids of 8 x 8 rotating quads, each showing
    // one of 64 small textures from a bindless texture array. The left grid is one instanced draw,
    // its pixel shader indexing the array with the instance (a non-uniform index). The right grid
    // is a draw per quad, each preceded by writing the quad's texture into the next slot of a
    // 2048-slot table already bound (update after bind), its shader reading that slot from a push
    // constant. D3D11 has no bindless tables: D3D12 and Vulkan only. The sample's UI only lists
    // Vulkan's descriptor indexing limits: no UI here.
    class DescriptorIndexingPass {
        private app: App;

        private nonUniformVS: Opaque;
        private nonUniformPS: Opaque;
        private updateAfterBindVS: Opaque;
        private updateAfterBindPS: Opaque;
        private bindingLayout: Opaque;
        private bindlessLayout: Opaque;
        private bindingSet: BindingSet;
        // The sample's two descriptor sets: the 64 textures, and the streamed one.
        private nonUniformTable: Opaque;
        private updateAfterBindTable: Opaque;
        private textures: Opaque[];
        private quadIndexBuffer: Opaque;
        private descriptorOffset: int;

        // The quads' rotation: a fraction of a turn, 0.2 turns per second.
        private accumulatedTime: number;
        // -benchmark: 1/60 second per frame, as vulkan_samples' --benchmark.
        benchmark: boolean;

        // A framebuffer per back buffer, for the back buffers' size, and the pipelines made for them.
        private framebuffers: Opaque[];
        private targetWidth: int;
        private targetHeight: int;
        private nonUniformPipeline: Opaque;
        private updateAfterBindPipeline: Opaque;
        private pipelinesCreated: boolean;

        // Upload buffer.
        private push: f32[];

        constructor(app: App) {
            this.app = app;
            this.textures = [];
            this.descriptorOffset = 0;
            this.accumulatedTime = 0.0;
            this.benchmark = false;
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
            this.pipelinesCreated = false;
            this.push = [0.0, 0.0, 0.0];
        }

        // The sample's render: the time accumulated in float, wrapped to [0, 1).
        onAnimate(elapsedSeconds: number): void {
            const deltaTime = Math.fround(this.benchmark ? 1.0 / 60.0 : elapsedSeconds);
            const time = Math.fround(this.accumulatedTime + Math.fround(Math.fround(0.2) * deltaTime));
            this.accumulatedTime = Math.fround(time - Math.floor(time));
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        // The framebuffers of the back buffers go before the back buffers do.
        onBackBufferResizing(): void {
            this.releaseTargets();
        }

        releaseTargets(): void {
            for (let i = 0; i < this.framebuffers.length; i++) {
                this.app.releaseResource(this.framebuffers[i]);
            }
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
        }

        // The sample's pipelines: triangle strips, no culling, no depth, no blending.
        createPipeline(vs: Opaque, ps: Opaque): Opaque {
            const desc = GraphicsPipelineDesc.create(vs, ps);
            desc.setPrimitiveType(PrimitiveType.TriangleStrip);
            desc.addBindingLayout(this.bindingLayout);
            desc.addBindingLayout(this.bindlessLayout);
            desc.setDepthState(0, 0, ComparisonFunc.Always);
            desc.setRasterState(CullMode.None, FillMode.Solid, 0);
            return this.app.createGraphicsPipelineFromDesc(desc, this.framebuffers[0]);
        }

        createTargets(width: int, height: int): void {
            this.releaseTargets();
            const count = this.app.getBackBufferCount();
            for (let i = 0; i < count; i++) {
                this.framebuffers.push(this.app.createFramebuffer(this.app.getBackBuffer(i), null));
            }
            if (!this.pipelinesCreated) {
                this.nonUniformPipeline = this.createPipeline(this.nonUniformVS, this.nonUniformPS);
                this.updateAfterBindPipeline = this.createPipeline(this.updateAfterBindVS, this.updateAfterBindPS);
                this.pipelinesCreated = true;
            }
            this.targetWidth = width;
            this.targetHeight = height;
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (this.targetWidth != width || this.targetHeight != height) {
                this.createTargets(width, height);
            }

            const index = this.app.getCurrentBackBufferIndex();
            commandList.clearTextureFloat(this.app.getBackBuffer(index), CLEAR_COLOR[0], CLEAR_COLOR[1], CLEAR_COLOR[2], 0.0);
            const framebuffer = this.framebuffers[index];

            this.push[0] = Math.fround(Math.fround(2.0 * Math.PI) * this.accumulatedTime);

            // The left grid: one draw of 64 instances, each indexing the table with its own index.
            frame.beginDrawToFramebuffer(this.nonUniformPipeline, framebuffer);
            frame.drawAddBindingSet(this.bindingSet);
            frame.drawAddDescriptorTable(this.nonUniformTable);
            frame.drawSetIndexBuffer(this.quadIndexBuffer);
            frame.drawIndexedInstancedWithPushConstants(4, NUM_DESCRIPTORS_NON_UNIFORM, Ref(this.push[0]), PUSH_SIZE);

            // The right grid: per quad, its texture written into the streamed table's next slot
            // (the table already bound to this command list), the slot passed in the push constants.
            frame.beginDrawToFramebuffer(this.updateAfterBindPipeline, framebuffer);
            frame.drawAddBindingSet(this.bindingSet);
            frame.drawAddDescriptorTable(this.updateAfterBindTable);
            frame.drawSetIndexBuffer(this.quadIndexBuffer);
            for (let i = 0; i < NUM_DESCRIPTORS_NON_UNIFORM; i++) {
                this.app.writeDescriptorTableTexture(this.updateAfterBindTable, this.descriptorOffset, this.textures[i]);
                Donut_StoreInt32(Ref(this.push[1]), this.descriptorOffset);
                Donut_StoreInt32(Ref(this.push[2]), i);
                this.descriptorOffset = (this.descriptorOffset + 1) % NUM_DESCRIPTORS_STREAMING;
                frame.drawIndexedWithPushConstants(4, Ref(this.push[0]), PUSH_SIZE);
            }
        }

        // The sample's create_images: 64 colors in [0.2, 0.8) from its random engine (seed 42),
        // then each image made with its color, and written into the non-uniform table.
        createImages(commandList: CommandList): void {
            const rng = this.app.createRandomEngine(42);
            let colors: number[] = [];
            for (let i = 0; i < NUM_DESCRIPTORS_NON_UNIFORM * 3; i++) {
                colors.push(Donut_RandomUniformFloat(rng, 0.2, 0.8));
            }
            for (let i = 0; i < NUM_DESCRIPTORS_NON_UNIFORM; i++) {
                let texels = createImageData([colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]], i, rng);
                const texture = this.app.createTextureWithLevels(IMAGE_SIZE, IMAGE_SIZE, 1, Format.RGBA8_UNORM, `Test image ${i}`);
                commandList.writeTextureLevel(texture, 0, Ref(texels[0]), IMAGE_SIZE * 4);
                this.app.writeDescriptorTableTexture(this.nonUniformTable, i, texture);
                this.textures.push(texture);
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const shader = "descriptor_indexing.hlsl";
            this.nonUniformVS = this.app.createShader(shader, "nonuniform_vs", ShaderType.Vertex);
            this.nonUniformPS = this.app.createShader(shader, "nonuniform_ps", ShaderType.Pixel);
            this.updateAfterBindVS = this.app.createShader(shader, "update_after_bind_vs", ShaderType.Vertex);
            this.updateAfterBindPS = this.app.createShader(shader, "update_after_bind_ps", ShaderType.Pixel);
            if (!this.nonUniformVS || !this.nonUniformPS || !this.updateAfterBindVS || !this.updateAfterBindPS) {
                return false;
            }

            // The push constants and the immutable sampler (linear, the nearest level, clamped).
            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutPushConstants(0, PUSH_SIZE);
            layoutDesc.layoutSampler(0);
            this.bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.All);
            const setDesc = BindingSetDesc.create();
            setDesc.bindPushConstants(0, PUSH_SIZE);
            setDesc.bindSampler(0, this.app.createSamplerWithDesc(1, 1, 0, SamplerAddressMode.Clamp, 0.0, 0.0, 1000.0, 1.0));
            this.bindingSet = this.app.createBindingSetForLayout(setDesc, this.bindingLayout);

            // The bindless texture array (register space 1), and the sample's two tables of it.
            const bindlessLayoutDesc = BindlessLayoutDesc.create(0, NUM_DESCRIPTORS_STREAMING, ShaderType.Pixel);
            bindlessLayoutDesc.addTextures(1);
            this.bindlessLayout = this.app.createBindlessLayout(bindlessLayoutDesc);
            this.nonUniformTable = this.app.createDescriptorTable(this.bindlessLayout, NUM_DESCRIPTORS_NON_UNIFORM);
            this.updateAfterBindTable = this.app.createDescriptorTable(this.bindlessLayout, NUM_DESCRIPTORS_STREAMING);
            if (!this.nonUniformTable || !this.updateAfterBindTable) {
                console.log("Cannot create the descriptor tables");
                return false;
            }

            // A quad's corners as a triangle strip.
            let quadIndices: int[] = [0, 1, 2, 3];
            const commandList = this.app.createCommandList();
            commandList.open();
            this.quadIndexBuffer = this.app.createStaticIndexBuffer(commandList, Ref(quadIndices[0]), 16, "Quad");
            this.createImages(commandList);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);

            const pass = this.app.addPass();
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("descriptor_indexing");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -benchmark: 1/60 second per frame (as vulkan_samples' --benchmark).
        let options = AppOptions.None;
        let benchmark = false;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "-benchmark") {
                benchmark = true;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        if (api == GraphicsAPI.D3D11) {
            console.log("Descriptor indexing needs bindless descriptor tables: run with -d3d12 or -vk");
            return 1;
        }
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const pass = new DescriptorIndexingPass(app);
        pass.benchmark = benchmark;
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
    return DescriptorIndexing.main(argc, argv);
}

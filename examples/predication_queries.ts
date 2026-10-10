// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace PredicationQueries {
    const WINDOW_TITLE = "D3D12 Predication and Queries sample";

    // The sample's vertex: position, color.
    const VERTEX_STRIDE = 28;
    // SceneConstantBuffer: float4 offset, padded to a constant buffer's 256 bytes.
    const CB_SIZE = 256;
    // OnUpdate's: the near quad moves right this much a frame, wrapping past the bounds.
    const TRANSLATION_SPEED = 0.01;
    const OFFSET_BOUNDS = 1.5;
    // Its frames run at the display's 60 Hz: 60 steps a second here (one a frame with -benchmark).
    const STEPS_PER_SECOND = 60.0;

    // Port of DirectX-Graphics-Samples' D3D12PredicationQueries: a white quad behind a translucent
    // red-yellow one moving across it; each frame a binary occlusion query draws the far quad's
    // bounding box (just in front of it, without writing color or depth) after the near quad, and
    // the next frame draws the far quad only if the query found any of the box visible, so it
    // disappears while the near quad covers it.
    class PredicationQueriesPass {
        private app: App;
        private bindingLayout: Opaque;
        private vertexShader: Opaque;
        private pixelShader: Opaque;
        private inputLayout: Opaque;
        private vertexBuffer: Opaque;
        private farQuadConstants: Opaque;
        private nearQuadConstants: Opaque;
        private farQuadBindingSet: BindingSet;
        private nearQuadBindingSet: BindingSet;
        private occlusion: Opaque;
        private hasTargets: boolean;
        private colorBuffer: Opaque;
        private depthBuffer: Opaque;
        private framebuffer: Opaque;
        private pipeline: Opaque;
        private queryPipeline: Opaque;
        private nearOffset: f32[];
        // The far quad's: no offset.
        private farOffset: f32[];
        private stepFraction: number;

        benchmark: boolean;

        constructor(app: App) {
            this.app = app;
            this.farQuadBindingSet = new BindingSet(null);
            this.nearQuadBindingSet = new BindingSet(null);
            this.hasTargets = false;
            this.nearOffset = [];
            this.farOffset = [];
            for (let i = 0; i < CB_SIZE / 4; i++) {
                this.nearOffset.push(0.0);
                this.farOffset.push(0.0);
            }
            this.stepFraction = 0.0;
            this.benchmark = false;
        }

        onBackBufferResizing(): void {
            if (!this.hasTargets) {
                return;
            }
            this.app.releaseResource(this.pipeline);
            this.app.releaseResource(this.queryPipeline);
            this.app.releaseResource(this.framebuffer);
            this.app.releaseResource(this.colorBuffer);
            this.app.releaseResource(this.depthBuffer);
            this.app.clearBindingCache();
            this.hasTargets = false;
        }

        // OnUpdate: the near quad moves right, back to the left past the bounds.
        step(): void {
            this.nearOffset[0] = Math.fround(this.nearOffset[0] + TRANSLATION_SPEED);
            if (this.nearOffset[0] > OFFSET_BOUNDS) {
                this.nearOffset[0] = -OFFSET_BOUNDS;
            }
        }

        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
            if (this.benchmark) {
                this.step();
                return;
            }
            this.stepFraction += elapsedSeconds * STEPS_PER_SECOND;
            while (this.stepFraction >= 1.0) {
                this.step();
                this.stepFraction -= 1.0;
            }
        }

        // The sample's back buffer (RGBA8_UNORM) and D32_FLOAT depth buffer, here a color target
        // blitted into the back buffer; and its two pipeline states for them.
        createTargets(width: int, height: int): void {
            this.colorBuffer = this.app.createRenderTargetTexture(width, height, Format.RGBA8_UNORM, "ColorBuffer");
            this.depthBuffer = this.app.createRenderTargetTexture(width, height, Format.D32, "DepthBuffer");
            this.framebuffer = this.app.createFramebuffer(this.colorBuffer, this.depthBuffer);

            // Triangle strips, alpha blended (the alpha itself replaced), the default depth state
            // (less, writes) and rasterizer state.
            const desc = GraphicsPipelineDesc.create(this.vertexShader, this.pixelShader);
            desc.setInputLayout(this.inputLayout);
            desc.addBindingLayout(this.bindingLayout);
            desc.setPrimitiveType(PrimitiveType.TriangleStrip);
            desc.setDepthState(1, 1, ComparisonFunc.Less);
            desc.setBlendState(1, BlendFactor.SrcAlpha, BlendFactor.InvSrcAlpha, BlendOp.Add,
                BlendFactor.One, BlendFactor.Zero, BlendOp.Add);
            this.pipeline = this.app.createGraphicsPipelineFromDesc(desc, this.framebuffer);

            // The occlusion query's: no color or depth writes.
            const queryDesc = GraphicsPipelineDesc.create(this.vertexShader, this.pixelShader);
            queryDesc.setInputLayout(this.inputLayout);
            queryDesc.addBindingLayout(this.bindingLayout);
            queryDesc.setPrimitiveType(PrimitiveType.TriangleStrip);
            queryDesc.setDepthState(1, 0, ComparisonFunc.Less);
            queryDesc.setColorWriteMask(ColorMask.None);
            this.queryPipeline = this.app.createGraphicsPipelineFromDesc(queryDesc, this.framebuffer);
            this.hasTargets = true;
        }

        // A quad: four vertices from `first` of the vertex buffer, with a quad's constants.
        beginQuad(frame: Frame, pipeline: Opaque, bindingSet: BindingSet, first: int): void {
            frame.beginDrawToFramebuffer(pipeline, this.framebuffer);
            frame.drawAddBindingSet(bindingSet);
            frame.drawAddVertexBuffer(this.vertexBuffer, 0, first * VERTEX_STRIDE);
        }

        // PopulateCommandList: back to front, for the transparency.
        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const commandList = frame.getCommandList();
            if (!this.hasTargets) {
                this.createTargets(frame.getWidth(), frame.getHeight());
            }
            // Volatile: written by each frame.
            commandList.writeBuffer(this.farQuadConstants, Ref(this.farOffset[0]), CB_SIZE);
            commandList.writeBuffer(this.nearQuadConstants, Ref(this.nearOffset[0]), CB_SIZE);

            commandList.clearTextureFloat(this.colorBuffer, 0.0, 0.2, 0.4, 1.0);
            commandList.clearDepth(this.depthBuffer, 1.0);

            // The far quad, if the previous frame's occlusion query found its box visible.
            this.beginQuad(frame, this.pipeline, this.farQuadBindingSet, 0);
            frame.drawVerticesOcclusionPredicated(4, this.occlusion, 0);

            // The near quad, always.
            this.beginQuad(frame, this.pipeline, this.nearQuadBindingSet, 4);
            frame.drawVertices(4);

            // The occlusion query with the far quad's bounding box, resolved for the next frame.
            this.beginQuad(frame, this.queryPipeline, this.farQuadBindingSet, 8);
            frame.drawVerticesWithOcclusionQuery(4, this.occlusion, 0);
            frame.resolveOcclusionQueries(this.occlusion);

            this.app.blitTexture(frame, this.colorBuffer);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const occlusion = this.app.createOcclusionPredication(1);
            if (!occlusion) {
                console.log("The graphics device has no predication (D3D12, or Vulkan with VK_EXT_conditional_rendering)");
                return false;
            }
            this.occlusion = occlusion as Opaque;

            this.vertexShader = this.app.createShader("predication_queries.hlsl", "VSMain", ShaderType.Vertex);
            this.pixelShader = this.app.createShader("predication_queries.hlsl", "PSMain", ShaderType.Pixel);
            if (!this.vertexShader || !this.pixelShader) {
                return false;
            }
            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_STRIDE);
            layoutDesc.addVertexAttribute("COLOR", Format.RGBA32_FLOAT, 12, 0, VERTEX_STRIDE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vertexShader);

            const bindingLayoutDesc = BindingLayoutDesc.create();
            bindingLayoutDesc.layoutVolatileConstantBuffer(0);
            this.bindingLayout = this.app.createBindingLayout(bindingLayoutDesc, ShaderType.Vertex);
            this.farQuadConstants = this.app.createVolatileConstantBuffer(CB_SIZE, "FarQuadConstants");
            this.nearQuadConstants = this.app.createVolatileConstantBuffer(CB_SIZE, "NearQuadConstants");
            const farSetDesc = BindingSetDesc.create();
            farSetDesc.bindEntireConstantBuffer(0, this.farQuadConstants);
            this.farQuadBindingSet = this.app.createBindingSetForLayout(farSetDesc, this.bindingLayout);
            const nearSetDesc = BindingSetDesc.create();
            nearSetDesc.bindEntireConstantBuffer(0, this.nearQuadConstants);
            this.nearQuadBindingSet = this.app.createBindingSetForLayout(nearSetDesc, this.bindingLayout);

            // Two quads and a bounding box for the occlusion query, in clip space (the window's
            // aspect ratio applied to y), drawn back to front.
            const a = Math.fround(1280.0 / 720.0);
            const far = Math.fround(0.25 * a);
            const near = Math.fround(0.35 * a);
            let vertices: f32[] = [
                // Far quad - in practice this would be a complex geometry.
                -0.25, -far, 0.5, 1.0, 1.0, 1.0, 1.0,
                -0.25, far, 0.5, 1.0, 1.0, 1.0, 1.0,
                0.25, -far, 0.5, 1.0, 1.0, 1.0, 1.0,
                0.25, far, 0.5, 1.0, 1.0, 1.0, 1.0,
                // Near quad.
                -0.5, -near, 0.0, 1.0, 0.0, 0.0, 0.65,
                -0.5, near, 0.0, 1.0, 0.0, 0.0, 0.65,
                0.5, -near, 0.0, 1.0, 1.0, 0.0, 0.65,
                0.5, near, 0.0, 1.0, 1.0, 0.0, 0.65,
                // Far quad bounding box used for occlusion query (offset slightly to avoid z-fighting).
                -0.25, -far, 0.4999, 0.0, 0.0, 0.0, 1.0,
                -0.25, far, 0.4999, 0.0, 0.0, 0.0, 1.0,
                0.25, -far, 0.4999, 0.0, 0.0, 0.0, 1.0,
                0.25, far, 0.4999, 0.0, 0.0, 0.0, 1.0,
            ];
            // Blitting creates Donut's common passes: before any command list is open.
            this.app.getCommonSampler(CommonSampler.LinearClamp);
            const commandList = this.app.createCommandList();
            commandList.open();
            this.vertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(vertices[0]), vertices.length * 4, "Quads");
            commandList.close();
            this.app.executeCommandList(commandList);
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
        Donut_SetAppName("predication_queries");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -benchmark: one animation step a frame, as the sample.
        // UNORM back buffers, as the sample's R8G8B8A8_UNORM.
        let options = AppOptions.UnormBackBuffer;
        let benchmark = false;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = options | AppOptions.DebugRuntime;
            } else if (arg == "-benchmark") {
                benchmark = true;
            }
        }

        // The sample's window.
        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        console.log(`Renderer: ${app.getRendererString()}`);

        const pass = new PredicationQueriesPass(app);
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
    return PredicationQueries.main(argc, argv);
}

// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { matrixPerspectiveFovLH, matrixTranspose } from "../core/directx_math";
import { KEY_SPACE, ACTION_PRESS } from "../core/glfw_input";

namespace ExecuteIndirect {
    const WINDOW_TITLE = "D3D12 Execute Indirect sample - Press the SPACE bar to toggle GPU primitive culling";

    // The sample's frames in flight: each has its own copy of the triangles' constants and commands.
    const FRAME_COUNT = 3;
    const TRIANGLE_COUNT = 1024;
    const TRIANGLE_RESOURCE_COUNT = TRIANGLE_COUNT * FRAME_COUNT;
    // Should match compute shader's threadBlockSize.
    const COMPUTE_THREAD_BLOCK_SIZE = 128;
    // The x and y offsets of the triangle vertices, their z, and the culling planes' +/- x in
    // homogenous space.
    const TRIANGLE_HALF_WIDTH = Math.fround(0.05);
    const TRIANGLE_DEPTH = 1.0;
    const CULLING_CUTOFF = 0.5;

    // SceneConstantBuffer: velocity, offset, color, projection, padding: 256 bytes.
    const CONSTANTS_STRIDE = 256;
    const CONSTANT_FLOATS = 64;
    // An indexed indirect draw's arguments: 5 uints.
    const COMMAND_SIZE = 20;
    const COMMAND_INTS = 5;
    // The culling shader's push constants: xOffset, zOffset, cullOffset, commandCount, frameOffset
    // (floats).
    const ROOT_CONSTANTS_SIZE = 20;

    // The sample's clear color, (0, 0.2, 0.4).
    const CLEAR_R = 0.0;
    const CLEAR_G = 0.2;
    const CLEAR_B = 0.4;

    // Test mode: the frames rendered, culling on: the triangles start left of the screen and drift in.
    const TEST_FRAMES = 300;

    // The C runtime's rand() as MSVC's has it (the sample never seeds it: seed 1) and the sample's
    // GetRandomFloat over it, in float.
    class Rand {
        private state: number;

        constructor() {
            this.state = 1;
        }

        next() {
            this.state = (this.state * 214013 + 2531011) % 4294967296;
            return Math.floor(this.state / 65536) & 0x7FFF;
        }

        float(min: number, max: number) {
            const scale = Math.fround(Math.fround(this.next()) / 32767.0);
            const range = Math.fround(Math.fround(max) - Math.fround(min));
            return Math.fround(Math.fround(scale * range) + Math.fround(min));
        }
    }

    // Port of DirectX-Graphics-Samples' D3D12ExecuteIndirect: 1024 triangles drifting across the
    // screen, each with its own constants, drawn by one indirect call of 1024 commands; with culling
    // on (Space switches it), a compute shader first keeps only the commands of the triangles within
    // the middle half of the screen (the draw scissored to it) and the indirect call takes their
    // count from a buffer. The sample's compute queue is the frame's command list here, its root
    // CBV per command an instance index (see execute_indirect.hlsl). The sample's back buffer
    // (R8G8B8A8_UNORM) and D32_FLOAT depth buffer are a color target here, blitted into the back
    // buffer.
    class ExecuteIndirectPass {
        private app: App;
        private vertexShader: ShaderHandle;
        private pixelShader: ShaderHandle;
        private computeShader: ShaderHandle;
        private inputLayout: InputLayoutHandle;
        private bindingLayout: BindingLayoutHandle;
        private computeLayout: BindingLayoutHandle;
        private bindingSet: BindingSet;
        private computeSets: BindingSet[];
        private computePipeline: ComputePipelineHandle;
        private vertexBuffer: BufferHandle;
        private triangleIndexBuffer: BufferHandle;
        private indexBuffer: BufferHandle;
        private constantBuffer: BufferHandle;
        private commandBuffer: BufferHandle;
        private processedCommandBuffers: BufferHandle[];
        private countBuffers: BufferHandle[];
        private hasTargets: boolean;
        private colorBuffer: TextureHandle;
        private depthBuffer: TextureHandle;
        private framebuffer: FramebufferHandle;
        private pipeline: GraphicsPipelineHandle;
        // The triangles' constants (m_constantBufferData), 64 floats each.
        private constants: f32[];
        private rootConstants: f32[];
        private zero: int[];
        private rand: Rand;
        private frameIndex: int;
        private width: int;
        private height: int;
        enableCulling: boolean;

        constructor(app: App) {
            this.app = app;
            this.computeSets = [];
            this.processedCommandBuffers = [];
            this.countBuffers = [];
            this.hasTargets = false;
            this.constants = [];
            this.rootConstants = [TRIANGLE_HALF_WIDTH, TRIANGLE_DEPTH, CULLING_CUTOFF, TRIANGLE_COUNT, 0.0];
            this.zero = [0];
            this.rand = new Rand();
            this.frameIndex = 0;
            this.width = 1280;
            this.height = 720;
            this.enableCulling = true;
        }

        init() {
            const shader = "execute_indirect.hlsl";
            this.vertexShader = this.app.createShader(shader, "VSMain", ShaderType.Vertex);
            this.pixelShader = this.app.createShader(shader, "PSMain", ShaderType.Pixel);
            this.computeShader = this.app.createShader(shader, "CSMain", ShaderType.Compute);
            if (!this.vertexShader || !this.pixelShader || !this.computeShader) {
                return false;
            }
            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, 12);
            layoutDesc.addInstanceVertexAttribute("TRIANGLE", Format.R32_UINT, 0, 1, 4);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vertexShader);

            const commandList = this.app.createCommandList();
            commandList.open();
            this.createResources(commandList);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);

            // The vertex shader's constants; the culling's constants, commands and outputs.
            const layoutDescG = BindingLayoutDesc.create();
            layoutDescG.layoutStructuredBufferSRV(0);
            this.bindingLayout = this.app.createBindingLayout(layoutDescG, ShaderType.Vertex);
            const setDesc = BindingSetDesc.create();
            setDesc.bindStructuredBufferSRV(0, this.constantBuffer);
            this.bindingSet = this.app.createBindingSetForLayout(setDesc, this.bindingLayout);

            const computeLayoutDesc = BindingLayoutDesc.create();
            computeLayoutDesc.layoutPushConstants(0, ROOT_CONSTANTS_SIZE);
            computeLayoutDesc.layoutStructuredBufferSRV(0);
            computeLayoutDesc.layoutRawBufferSRV(1);
            computeLayoutDesc.layoutRawBufferUAV(0);
            computeLayoutDesc.layoutRawBufferUAV(1);
            this.computeLayout = this.app.createBindingLayout(computeLayoutDesc, ShaderType.Compute);
            for (let f = 0; f < FRAME_COUNT; f++) {
                const computeSetDesc = BindingSetDesc.create();
                computeSetDesc.bindPushConstants(0, ROOT_CONSTANTS_SIZE);
                computeSetDesc.bindStructuredBufferSRV(0, this.constantBuffer);
                computeSetDesc.bindRawBufferSRV(1, this.commandBuffer);
                computeSetDesc.bindRawBufferUAV(0, this.processedCommandBuffers[f]);
                computeSetDesc.bindRawBufferUAV(1, this.countBuffers[f]);
                this.computeSets.push(this.app.createBindingSetForLayout(computeSetDesc, this.computeLayout));
            }
            this.computePipeline = this.app.createComputePipelineWithLayout(this.computeShader, this.computeLayout);
            // Blitting creates Donut's common passes: before any command list is open.
            this.app.getCommonSampler(CommonSampler.LinearClamp);

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }

        onKey(key: int, scancode: int, action: int, mods: int) {
            if (key == KEY_SPACE && action == ACTION_PRESS) {
                this.enableCulling = !this.enableCulling;
                return 1;
            }
            return 0;
        }

        // OnUpdate: the triangles move right, coming back at the left with a new speed past the
        // bounds; the frame's copy of their constants is written in the render callback.
        onAnimate(elapsedSeconds: number) {
            this.app.setWindowTitle(WINDOW_TITLE);
            const offsetBounds = 2.5;
            const c = this.constants;
            for (let n = 0; n < TRIANGLE_COUNT; n++) {
                const base = n * CONSTANT_FLOATS;
                c[base + 4] = Math.fround(c[base + 4] + c[base]);
                if (c[base + 4] > offsetBounds) {
                    c[base] = this.rand.float(0.01, 0.02);
                    c[base + 4] = -offsetBounds;
                }
            }
        }

        onBackBufferResizing() {
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

        // The projection of every triangle's constants for the back buffer's aspect ratio: the
        // sample's window is always 1280x720, this one's is the display's on Android.
        updateProjection() {
            const aspectRatio = Math.fround(Math.fround(this.width) / Math.fround(this.height));
            const projection = matrixTranspose(matrixPerspectiveFovLH(Math.fround(0.785398163), aspectRatio, 0.01, 20.0));
            for (let n = 0; n < TRIANGLE_COUNT; n++) {
                for (let i = 0; i < 16; i++) {
                    this.constants[n * CONSTANT_FLOATS + 12 + i] = projection[i];
                }
            }
        }

        // The sample's back buffer and depth buffer, and its pipeline state: triangle strips, the
        // default rasterizer state (back faces culled), blend state (opaque), depth state (less).
        // The culling band and the projection follow its size.
        createTargets(width: int, height: int) {
            this.width = width;
            this.height = height;
            this.updateProjection();
            this.colorBuffer = this.app.createRenderTargetTexture(width, height, Format.RGBA8_UNORM, "ColorBuffer");
            this.depthBuffer = this.app.createRenderTargetTexture(width, height, Format.D32, "DepthBuffer");
            this.framebuffer = this.app.createFramebuffer(this.colorBuffer, this.depthBuffer);

            const desc = GraphicsPipelineDesc.create(this.vertexShader, this.pixelShader);
            desc.setInputLayout(this.inputLayout);
            desc.addBindingLayout(this.bindingLayout);
            desc.setPrimitiveType(PrimitiveType.TriangleStrip);
            desc.setDepthState(1, 1, ComparisonFunc.Less);
            desc.setRasterState(CullMode.Back, FillMode.Solid, 0);
            // The culling band's scissor rectangle.
            desc.setScissorEnable(1);
            this.pipeline = this.app.createGraphicsPipelineFromDesc(desc, this.framebuffer);
            this.hasTargets = true;
        }

        // PopulateCommandLists: with culling, the compute shader culls the frame's commands into
        // its processed command buffer (its count reset first) and the draw is scissored to the
        // culling band; then the indirect draw of all or the kept commands.
        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const commandList = frame.getCommandList();
            if (!this.hasTargets) {
                this.createTargets(frame.getWidth(), frame.getHeight());
            }
            const f = this.frameIndex;
            commandList.writeBufferAt(this.constantBuffer, f * TRIANGLE_COUNT * CONSTANTS_STRIDE, Ref(this.constants[0]),
                TRIANGLE_COUNT * CONSTANTS_STRIDE);

            if (this.enableCulling) {
                commandList.writeBuffer(this.countBuffers[f], Ref(this.zero[0]), 4);
                // xOffset, zOffset, cullOffset, commandCount, and the frame's offset (a float here).
                this.rootConstants[4] = f * TRIANGLE_COUNT;
                commandList.dispatchWithPushConstants(this.computePipeline, this.computeSets[f], Ref(this.rootConstants[0]), ROOT_CONSTANTS_SIZE,
                    Math.ceil(TRIANGLE_COUNT / COMPUTE_THREAD_BLOCK_SIZE), 1, 1);
            }

            commandList.clearTextureFloat(this.colorBuffer, CLEAR_R, CLEAR_G, CLEAR_B, 1.0);
            commandList.clearDepth(this.depthBuffer, 1.0);

            frame.beginDrawToFramebuffer(this.pipeline, this.framebuffer);
            frame.drawAddBindingSet(this.bindingSet);
            frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
            frame.drawAddVertexBuffer(this.triangleIndexBuffer, 1, 0);
            frame.drawSetIndexBuffer(this.indexBuffer);
            if (this.enableCulling) {
                // m_cullingScissorRect: the middle half of the screen, as the culling planes.
                const center = Math.fround(this.width / 2.0);
                const left: int = Math.floor(Math.fround(center - Math.fround(center * CULLING_CUTOFF)));
                const right: int = Math.floor(Math.fround(center + Math.fround(center * CULLING_CUTOFF)));
                frame.drawSetScissor(left, 0, right, this.height);
                frame.drawSetIndirectBuffer(this.processedCommandBuffers[f]);
                frame.drawIndexedIndirectCount(this.countBuffers[f], 0, 0, TRIANGLE_COUNT);
            } else {
                frame.drawSetIndirectBuffer(this.commandBuffer);
                frame.drawIndexedIndirect(f * TRIANGLE_COUNT * COMMAND_SIZE, TRIANGLE_COUNT);
            }

            this.app.blitTexture(frame, this.colorBuffer);
            this.frameIndex = (this.frameIndex + 1) % FRAME_COUNT;
        }

        // LoadAssets: the triangle, its indices (the strip's three), the triangles' indices for the
        // instance attribute, their constants (random speeds, positions, colors), the commands of
        // every frame and the buffers the culling writes.
        createResources(commandList: CommandList) {
            const h = TRIANGLE_HALF_WIDTH;
            let vertices: f32[] = [
                0.0, h, TRIANGLE_DEPTH,
                h, -h, TRIANGLE_DEPTH,
                -h, -h, TRIANGLE_DEPTH,
            ];
            this.vertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(vertices[0]), vertices.length * 4, "Triangle");
            let indices: int[] = [0, 1, 2];
            this.indexBuffer = this.app.createStaticIndexBuffer(commandList, Ref(indices[0]), 12, "Indices");
            let triangleIndices: int[] = [];
            for (let i = 0; i < TRIANGLE_RESOURCE_COUNT; i++) {
                triangleIndices.push(i);
            }
            this.triangleIndexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(triangleIndices[0]), TRIANGLE_RESOURCE_COUNT * 4,
                "TriangleIndices");

            // The constant buffers: velocity, offset and color from GetRandomFloat, in the order the
            // sample's MSVC build calls it for the XMFLOAT4 constructors' arguments (offset z, y, x;
            // color g, r, b: read from its constants); the projection.
            const aspectRatio = Math.fround(Math.fround(this.width) / Math.fround(this.height));
            const projection = matrixTranspose(matrixPerspectiveFovLH(Math.fround(0.785398163), aspectRatio, 0.01, 20.0));
            for (let n = 0; n < TRIANGLE_COUNT; n++) {
                const velocity = this.rand.float(0.01, 0.02);
                const oz = this.rand.float(0.0, 2.0);
                const oy = this.rand.float(-1.0, 1.0);
                const ox = this.rand.float(-5.0, -1.5);
                const cg = this.rand.float(0.5, 1.0);
                const cr = this.rand.float(0.5, 1.0);
                const cb = this.rand.float(0.5, 1.0);
                const values = [velocity, 0.0, 0.0, 0.0, ox, oy, oz, 0.0, cr, cg, cb, 1.0];
                for (let i = 0; i < 12; i++) {
                    this.constants.push(values[i]);
                }
                for (let i = 0; i < 16; i++) {
                    this.constants.push(projection[i]);
                }
                for (let i = 0; i < 36; i++) {
                    this.constants.push(0.0);
                }
            }
            this.constantBuffer = this.app.createStructuredBuffer(CONSTANTS_STRIDE, TRIANGLE_RESOURCE_COUNT, "Constants");

            // Every frame's commands: a triangle each, its constants by its start instance.
            let commands: int[] = [];
            for (let i = 0; i < TRIANGLE_RESOURCE_COUNT; i++) {
                commands.push(3);
                commands.push(1);
                commands.push(0);
                commands.push(0);
                commands.push(i);
            }
            this.commandBuffer = this.app.createDrawIndexedIndirectBuffer(TRIANGLE_RESOURCE_COUNT, "Commands");
            commandList.writeBuffer(this.commandBuffer, Ref(commands[0]), TRIANGLE_RESOURCE_COUNT * COMMAND_SIZE);
            for (let f = 0; f < FRAME_COUNT; f++) {
                this.processedCommandBuffers.push(this.app.createDrawIndexedIndirectBuffer(TRIANGLE_COUNT, "ProcessedCommands"));
                this.countBuffers.push(this.app.createDrawIndexedIndirectBuffer(1, "ProcessedCommandCount"));
            }
        }
    }

    // -test: checks the last frame, culling on: outside the culling band (the middle half of the
    // screen) only the clear color; inside it, triangles.
    function checkFrame(app: App) {
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
        const left = width / 4;
        const right = width * 3 / 4;
        let inside = 0;
        let outside = 0;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if ((pixels[y * width + x] & 0xFFFFFF) != background) {
                    if (x >= left && x < right) {
                        inside++;
                    } else {
                        outside++;
                    }
                }
            }
        }
        console.log(`Triangle pixels inside the culling band ${inside}, outside ${outside}`);
        if (outside != 0) {
            return `${outside} triangle pixels outside the culling band`;
        }
        if (inside < 2000) {
            return `only ${inside} triangle pixels inside the culling band`;
        }
        return "";
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("execute_indirect");

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
        const support = app.getIndirectDrawSupport();
        if ((support & IndirectDrawSupport.MultiDraw) == 0 || (support & IndirectDrawSupport.FirstInstance) == 0
            || (support & IndirectDrawSupport.Count) == 0) {
            console.log("The graphics device can't draw several indirect draws, starting at other instances than 0, counted in a buffer");
            app.destroy();
            return 1;
        }

        const pass = new ExecuteIndirectPass(app);
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
    return ExecuteIndirect.main(argc, argv);
}

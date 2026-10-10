// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace Khr16BitArithmetic {
    const WINDOW_TITLE = "Donut Example: 16-bit Arithmetic";

    // The image the compute shader renders, and its workgroup size (8 x 8).
    const WIDTH = 1024;
    const HEIGHT = 1024;
    const GROUP_SIZE = 8;
    const NUM_BLOBS = 16;

    // The sample's blobs, each four 16-bit floats (x, y position, intensity, falloff):
    // std::default_random_engine(42) with a normal distribution (0, 0.1) for the position,
    // uniform ones in [0.4, 0.8) and [50, 100) for the others, converted by glm::packHalf2x16. The
    // values the sample's MSVC build generates (std::mt19937 and MSVC's distributions), as 16-bit
    // floats (x, y, intensity, falloff per line).
    const BLOBS = [
        0xaa9e, 0x2fd2, 0x3a3e, 0x5365,
        0x2c9e, 0x2d91, 0x391e, 0x54fd,
        0xaf9b, 0xa4ca, 0x3766, 0x52e0,
        0xac67, 0x9e7f, 0x39f9, 0x542b,
        0x279d, 0xaeb9, 0x3977, 0x5529,
        0xaf85, 0x2994, 0x382c, 0x5509,
        0x14ae, 0xa5d3, 0x3895, 0x5265,
        0xb1ea, 0x259e, 0x3928, 0x5460,
        0xac1c, 0xb01b, 0x38a9, 0x52d1,
        0x301b, 0x2ad0, 0x37ae, 0x5452,
        0x146d, 0x28b2, 0x3919, 0x5495,
        0x2e1c, 0x311f, 0x377e, 0x5488,
        0x2a52, 0x1edf, 0x39c9, 0x5454,
        0xa7ab, 0xa521, 0x3964, 0x53c2,
        0xabc2, 0x31f0, 0x372e, 0x5508,
        0x978e, 0x3014, 0x369f, 0x5355,
    ];

    // The push constants: struct Push32 { uint num_blobs; float seed; int range_x, range_y; } and
    // struct Push16 { uint16_t num_blobs; float16_t seed; int16_t range_x, range_y; }.
    const PUSH32_SIZE = 16;
    const PUSH16_SIZE = 8;
    const RANGE_X = 2;
    const RANGE_Y = 1;

    // glm::packHalf2x16's conversion of one float: to the nearest 16-bit float, ties to even.
    function packHalf(value: number): int {
        if (value == 0.0) {
            return 0;
        }
        const sign = value < 0.0 ? 0x8000 : 0;
        let a = Math.abs(value);
        let exponent = Math.floor(Math.log2(a));
        if (Math.pow(2.0, exponent) > a) {
            exponent--;
        } else if (Math.pow(2.0, exponent + 1) <= a) {
            exponent++;
        }
        if (exponent > 15) {
            return sign | 0x7C00;
        }
        // Subnormals below 2^-14: mantissa in units of 2^-24.
        const unit = exponent < -14 ? Math.pow(2.0, -24) : Math.pow(2.0, exponent - 10);
        let scaled = a / unit;
        let rounded = Math.floor(scaled);
        const remainder = scaled - rounded;
        if (remainder > 0.5 || (remainder == 0.5 && rounded % 2 == 1)) {
            rounded++;
        }
        if (exponent < -14) {
            return sign | rounded;
        }
        // rounded is in [1024, 2048]: 2048 carries into the exponent.
        let e = exponent + 15;
        if (rounded == 2048) {
            rounded = 1024;
            e++;
        }
        if (e > 30) {
            return sign | 0x7C00;
        }
        return sign | (e << 10) | (rounded - 1024);
    }

    // Port of Vulkan-Samples' 16bit_arithmetic: a compute shader renders 16 blobs that look like a
    // lens flare (a lot of arithmetic per pixel, the blobs' parameters 16-bit floats in a buffer)
    // into a 1024 x 1024 image, stretched over the screen. With 16-bit arithmetic enabled, a shader
    // doing it in 16-bit floats (native 16-bit types, float16_t), its push constants 16-bit values
    // too where the device takes them.
    class ArithmeticPass {
        private app: App;

        // The sample's setting, and what the device has.
        fp16Enabled: boolean;
        native16Bit: boolean;
        private native16BitConstants: boolean;

        private computeFP32: Opaque;
        private computeFP16: Opaque | null;
        private computeBindingLayout: Opaque;
        private computeBindingLayoutFP16: Opaque;
        private computeBindingSet: BindingSet;
        private computeBindingSetFP16: BindingSet;
        private blobBuffer: BufferHandle;
        private image: TextureHandle;
        private visualizeVS: ShaderHandle;
        private visualizePS: ShaderHandle;
        private visualizeBindingLayout: Opaque;
        private visualizeBindingSet: BindingSet;

        // The back buffer's size: color (sRGB, as the sample's swapchain).
        private colorBuffer: TextureHandle | null;
        private framebuffer: Opaque | null;
        private visualizePipeline: Opaque | null;

        private frameCount: int;
        private push32: f32[];
        private push16: int[];

        // The compute shader's GPU time.
        gpuTimeMs: number;
        hasGpuTime: boolean;
        private timerQuery: Opaque;
        private timerQueryInFlight: boolean;

        constructor(app: App) {
            this.app = app;
            this.fp16Enabled = false;
            this.native16Bit = false;
            this.native16BitConstants = false;
            this.computeFP16 = null;
            this.colorBuffer = null;
            this.framebuffer = null;
            this.visualizePipeline = null;
            this.frameCount = 0;
            this.push32 = [0.0, 0.0, 0.0, 0.0];
            this.push16 = [0, 0];
            this.gpuTimeMs = 0.0;
            this.hasGpuTime = false;
            this.timerQueryInFlight = false;
        }

        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        releaseTargets(): void {
            const resources: (ResourceHandle | null)[] = [this.visualizePipeline, this.framebuffer, this.colorBuffer];
            for (let i = 0; i < resources.length; i++) {
                const resource = resources[i];
                if (resource) {
                    this.app.releaseResource(resource);
                }
            }
            this.visualizePipeline = null;
            this.framebuffer = null;
            this.colorBuffer = null;
        }

        onBackBufferResizing(): void {
            this.releaseTargets();
            // The blit's cached binding sets still reference the old color buffer.
            this.app.clearBindingCache();
        }

        createTargets(width: int, height: int): void {
            const colorBuffer = this.app.createRenderTargetTexture(width, height, Format.SRGBA8_UNORM, "ColorBuffer");
            const framebuffer = this.app.createFramebuffer(colorBuffer, null);
            this.colorBuffer = colorBuffer;
            this.framebuffer = framebuffer;

            const desc = GraphicsPipelineDesc.create(this.visualizeVS, this.visualizePS);
            desc.addBindingLayout(this.visualizeBindingLayout);
            desc.setDepthState(0, 0, ComparisonFunc.Always);
            desc.setRasterState(CullMode.None, FillMode.Solid, 0);
            this.visualizePipeline = this.app.createGraphicsPipelineFromDesc(desc, framebuffer);
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (!this.framebuffer) {
                this.createTargets(width, height);
            }
            const framebuffer = this.framebuffer;
            const colorBuffer = this.colorBuffer;
            const visualizePipeline = this.visualizePipeline;
            if (!framebuffer || !colorBuffer || !visualizePipeline) {
                return;
            }

            // The seed: half a sine over 512 frames.
            this.frameCount = (this.frameCount + 1) & 511;
            const seedValue = 0.5 * Math.sin(2.0 * Math.PI * (this.frameCount / 512.0));

            if (this.timerQueryInFlight && this.app.pollTimerQuery(this.timerQuery) != 0) {
                this.gpuTimeMs = this.app.getTimerQueryTime(this.timerQuery) * 1000.0;
                this.hasGpuTime = true;
                this.app.resetTimerQuery(this.timerQuery);
                this.timerQueryInFlight = false;
            }
            const measure = !this.timerQueryInFlight;
            if (measure) {
                commandList.beginTimerQuery(this.timerQuery);
            }

            const computeFP16 = this.computeFP16;
            let fp16Dispatched = false;
            if (computeFP16) {
                if (this.fp16Enabled && this.native16BitConstants) {
                    // 16-bit push constants are supported by VK_KHR_16bit_storage, which is handy for
                    // conserving space without using many "unpack" instructions in the shader.
                    const seed16: int = packHalf(seedValue);
                    const rangeX: int = RANGE_X;
                    const rangeY: int = RANGE_Y;
                    this.push16[0] = NUM_BLOBS | (seed16 << 16);
                    this.push16[1] = (rangeX & 0xFFFF) | ((rangeY & 0xFFFF) << 16);
                    commandList.dispatchWithPushConstants(computeFP16, this.computeBindingSetFP16, Ref(this.push16[0]),
                        PUSH16_SIZE, WIDTH / GROUP_SIZE, HEIGHT / GROUP_SIZE, 1);
                    fp16Dispatched = true;
                } else if (this.fp16Enabled) {
                    this.writePush32(seedValue);
                    commandList.dispatchWithPushConstants(computeFP16, this.computeBindingSetFP16, Ref(this.push32[0]),
                        PUSH32_SIZE, WIDTH / GROUP_SIZE, HEIGHT / GROUP_SIZE, 1);
                    fp16Dispatched = true;
                }
            }
            if (!fp16Dispatched) {
                this.writePush32(seedValue);
                commandList.dispatchWithPushConstants(this.computeFP32, this.computeBindingSet, Ref(this.push32[0]),
                    PUSH32_SIZE, WIDTH / GROUP_SIZE, HEIGHT / GROUP_SIZE, 1);
            }

            if (measure) {
                commandList.endTimerQuery(this.timerQuery);
                this.timerQueryInFlight = true;
            }

            // Blit result to screen.
            commandList.clearTextureFloat(colorBuffer, 0.0, 0.0, 0.0, 1.0);
            frame.beginDrawToFramebuffer(visualizePipeline, framebuffer);
            frame.drawAddBindingSet(this.visualizeBindingSet);
            frame.drawVertices(3);

            this.app.blitTexture(frame, colorBuffer);
        }

        writePush32(seedValue: number): void {
            Donut_StoreInt32(Ref(this.push32[0]), NUM_BLOBS);
            this.push32[1] = seedValue;
            Donut_StoreInt32(Ref(this.push32[2]), RANGE_X);
            Donut_StoreInt32(Ref(this.push32[3]), RANGE_Y);
        }

        createComputeBindingSet(layout: Opaque, pushConstantsSize: int): BindingSet {
            const setDesc = BindingSetDesc.create();
            setDesc.bindStructuredBufferSRV(0, this.blobBuffer);
            setDesc.bindTextureUAV(0, this.image);
            setDesc.bindPushConstants(0, pushConstantsSize);
            return this.app.createBindingSetForLayout(setDesc, layout);
        }

        createComputeBindingLayout(pushConstantsSize: int): Opaque {
            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutStructuredBufferSRV(0);
            layoutDesc.layoutTextureUAV(0);
            layoutDesc.layoutPushConstants(0, pushConstantsSize);
            return this.app.createBindingLayout(layoutDesc, ShaderType.Compute);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            this.native16Bit = this.app.hasNative16BitShaderOps() != 0;
            this.native16BitConstants = this.app.hasNative16BitConstants() != 0;

            const shader = "16bit_arithmetic.hlsl";
            const computeFP32 = this.app.createShader(shader, "compute_fp32", ShaderType.Compute);
            this.visualizeVS = this.app.createShader(shader, "visualize_vs", ShaderType.Vertex);
            this.visualizePS = this.app.createShader(shader, "visualize_ps", ShaderType.Pixel);
            if (!computeFP32 || !this.visualizeVS || !this.visualizePS) {
                return false;
            }
            this.computeBindingLayout = this.createComputeBindingLayout(PUSH32_SIZE);
            this.computeFP32 = this.app.createComputePipelineWithLayout(computeFP32, this.computeBindingLayout);

            // The FP16 shader, with 16-bit push constants if the device takes them, 32-bit ones if not.
            if (this.native16Bit) {
                const computeFP16 = this.app.createShaderWithDefine("16bit_arithmetic_fp16.hlsl", "compute_fp16", ShaderType.Compute,
                    "PUSH_CONSTANT_16", this.native16BitConstants ? "1" : "0");
                if (!computeFP16) {
                    return false;
                }
                this.computeBindingLayoutFP16 = this.createComputeBindingLayout(this.native16BitConstants ? PUSH16_SIZE : PUSH32_SIZE);
                this.computeFP16 = this.app.createComputePipelineWithLayout(computeFP16, this.computeBindingLayoutFP16);
            }

            // The blobs, and the image the compute shader renders.
            this.blobBuffer = this.app.createStructuredBuffer(8, NUM_BLOBS, "BlobBuffer");
            this.image = this.app.createUAVTextureWithFormat(WIDTH, HEIGHT, Format.RGBA16_FLOAT, "Image");

            // The blit's common passes, created on first use, upload their textures on a command
            // list of their own: create them before ours (or the frame's) is open.
            this.app.getCommonSampler(CommonSampler.PointClamp);

            // Two 16-bit floats to a 32-bit word.
            const blobs: int[] = [];
            for (let i = 0; i < BLOBS.length; i += 2) {
                const low: int = BLOBS[i];
                const high: int = BLOBS[i + 1];
                blobs.push(low | (high << 16));
            }
            const commandList = this.app.createCommandList();
            commandList.open();
            commandList.writeBuffer(this.blobBuffer, Ref(blobs[0]), blobs.length * 4);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);

            this.computeBindingSet = this.createComputeBindingSet(this.computeBindingLayout, PUSH32_SIZE);
            if (this.computeFP16) {
                this.computeBindingSetFP16 = this.createComputeBindingSet(this.computeBindingLayoutFP16,
                    this.native16BitConstants ? PUSH16_SIZE : PUSH32_SIZE);
            }

            // The visualization: the image through a linear, clamped sampler.
            const visualizeLayoutDesc = BindingLayoutDesc.create();
            visualizeLayoutDesc.layoutTextureSRV(0);
            visualizeLayoutDesc.layoutSampler(0);
            this.visualizeBindingLayout = this.app.createBindingLayout(visualizeLayoutDesc, ShaderType.Pixel);
            const visualizeSetDesc = BindingSetDesc.create();
            visualizeSetDesc.bindTextureSRV(0, this.image);
            visualizeSetDesc.bindSampler(0, this.app.getCommonSampler(CommonSampler.LinearClamp));
            this.visualizeBindingSet = this.app.createBindingSetForLayout(visualizeSetDesc, this.visualizeBindingLayout);

            this.timerQuery = this.app.createTimerQuery();

            const pass = this.app.addPass();
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The sample's options window.
    class UserInterface {
        private sample: ArithmeticPass;

        constructor(sample: ArithmeticPass) {
            this.sample = sample;
        }

        buildUI(): void {
            const sample = this.sample;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("16-bit arithmetic", 1);
            if (sample.native16Bit) {
                sample.fp16Enabled = Donut_ImGuiCheckbox("Enable 16-bit arithmetic", sample.fp16Enabled ? 1 : 0) != 0;
            } else {
                Donut_ImGuiText("16-bit arithmetic (unsupported features)");
            }
            if (sample.hasGpuTime) {
                Donut_ImGuiText(`Compute shader: ${sample.gpuTimeMs.toFixed(3)} ms`);
            }
            Donut_ImGuiEnd();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App): boolean {
            return !app.addImGuiPass(this.buildUI).isNull();
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("16bit_arithmetic");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the options window.
        // -fp16: start with 16-bit arithmetic enabled (where the device has it).
        let options = AppOptions.None;
        let withUI = true;
        let fp16 = false;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-fp16") {
                fp16 = true;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const sample = new ArithmeticPass(app);
        if (!sample.init()) {
            app.destroy();
            return 1;
        }
        sample.fp16Enabled = fp16 && sample.native16Bit;

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(sample);
        if (withUI && !gui.init(app)) {
            console.log("Cannot initialize the user interface");
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
    return Khr16BitArithmetic.main(argc, argv);
}

// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { unsupported } from "../core/test_check";

namespace GenericPrograms {
    const WINDOW_TITLE = "D3D12 Hello Generic Programs";

    // The sample's vertex: float3 position, float4 color.
    const VERTEX_STRIDE = 28;

    // D3D_SHADER_MODEL_6_8: generic programs need it (though their shaders needn't be 6.8 ones).
    const SHADER_MODEL_6_8 = 0x68;

    // Test mode: the frames rendered, each 1/60 s.
    const TEST_FRAMES = 3;

    // Port of DirectX-Graphics-Samples' D3D12HelloGenericPrograms: the Hello Triangle sample's
    // triangle drawn twice, side by side, each time with a generic program instead of a pipeline
    // state object. A generic program is a graphics pipeline made as an (executable) state object
    // from building blocks: the vertex and pixel shaders, compiled on their own and used as DXIL
    // libraries (the vertex shader exported renamed, as myRenamedVS), the input layout, the root
    // signature, the primitive topology and the render target formats. The second program, for the
    // right triangle, is added to the first one's state object (AddToStateObject): the same vertex
    // shader export with another pixel shader (green at 1). Each draw sets its program (SetProgram)
    // and its viewport, the left or the right half of the window. D3D12 only, shader model 6.8.
    class GenericProgramsPass {
        private app: App;
        private vertexShader: ShaderHandle;
        private pixelShader: ShaderHandle;
        private pixelShader2: ShaderHandle;
        private inputLayout: InputLayoutHandle;
        private vertexBuffer: BufferHandle;
        // NVRHI's pipeline for the back buffer: the draws' root signature, render target and vertex
        // input state come from it, then its pipeline state is replaced by a program.
        private pipeline: GraphicsPipelineHandle | null;
        // The two programs: the first one's state object, then the one the second was added to.
        private programs: D3D12GenericProgramHandle[];

        constructor(app: App) {
            this.app = app;
            this.pipeline = null;
            this.programs = [];
        }

        releasePrograms(): void {
            for (const program of this.programs) {
                this.app.releaseObject(program);
            }
            this.programs = [];
            const pipeline = this.pipeline;
            if (pipeline) {
                this.app.releaseResource(pipeline);
                this.pipeline = null;
            }
        }

        onBackBufferResizing(): void {
            this.releasePrograms();
        }

        // LoadAssets' generic programs: myGenericProgram (myRenamedVS, PSMain), then
        // myGenericProgram2 (myRenamedVS, PSMain2) added to its state object.
        createPrograms(frame: Frame): boolean {
            const desc = GraphicsPipelineDesc.create(this.vertexShader, this.pixelShader);
            desc.setInputLayout(this.inputLayout);
            desc.setDepthState(0, 0, ComparisonFunc.Always);
            const pipeline = this.app.createGraphicsPipelineFromDescForFrame(desc, frame);
            this.pipeline = pipeline;

            const program = this.app.createD3D12GenericProgram(pipeline, this.inputLayout, this.vertexShader, "myRenamedVS",
                this.pixelShader, "PSMain", "myGenericProgram");
            if (!program) {
                return false;
            }
            this.programs.push(program as D3D12GenericProgramHandle);
            const program2 = this.app.addD3D12GenericProgram(program as D3D12GenericProgramHandle, this.pixelShader2, "PSMain2", "myGenericProgram2");
            if (!program2) {
                return false;
            }
            this.programs.push(program2 as D3D12GenericProgramHandle);
            return true;
        }

        // PopulateCommandList: the triangle with each program, in each half of the window.
        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            if (this.programs.length == 0 && !this.createPrograms(frame)) {
                return;
            }
            const pipeline = this.pipeline;
            if (!pipeline) {
                return;
            }
            const width = frame.getWidth();
            const height = frame.getHeight();
            // The sample's viewports: width / 2 wide (UINT division), the whole height.
            const halfWidth = Math.floor(width / 2);
            frame.clearColor(0.0, 0.2, 0.4, 1.0);
            for (let i = 0; i < this.programs.length; i++) {
                frame.beginDraw(pipeline);
                frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
                let left = 0.0;
                if (i == 1) {
                    left = width / 2;
                }
                frame.drawSetViewport(left, 0.0, halfWidth, height);
                frame.drawD3D12GenericProgram(this.programs[i], 3);
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            this.vertexShader = this.app.createShader("generic_programs.hlsl", "VSMain", ShaderType.Vertex);
            this.pixelShader = this.app.createShader("generic_programs.hlsl", "PSMain", ShaderType.Pixel);
            this.pixelShader2 = this.app.createShader("generic_programs.hlsl", "PSMain2", ShaderType.Pixel);
            if (!this.vertexShader || !this.pixelShader || !this.pixelShader2) {
                return false;
            }
            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_STRIDE);
            layoutDesc.addVertexAttribute("COLOR", Format.RGBA32_FLOAT, 12, 0, VERTEX_STRIDE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vertexShader);

            // The triangle, its height scaled by the window's aspect ratio (in float, as the
            // sample's).
            const aspectRatio = Math.fround(1280.0 / 720.0);
            const y = Math.fround(0.25 * aspectRatio);
            const vertices: number[] = [
                0.0, y, 0.0, 1.0, 0.0, 0.0, 1.0,
                0.25, -y, 0.0, 0.0, 1.0, 0.0, 1.0,
                -0.25, -y, 0.0, 0.0, 0.0, 1.0, 1.0,
            ];
            let floats = vertices.map((v): f32 => v);
            const commandList = this.app.createCommandList();
            commandList.open();
            this.vertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(floats[0]), floats.length * 4, "Triangle");
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);

            const pass = this.app.addPass();
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // -test: checks the last frame. The corners are the clear color; each half has a triangle in
    // the middle: the left one's center its interpolated colors (green below 1), the right one's
    // with green at 1.
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
        const corners = [0, width - 1, (height - 1) * width, height * width - 1];
        for (let i = 0; i < corners.length; i++) {
            const p = pixels[corners[i]] & 0xFFFFFF;
            if (p != background) {
                return `corner pixel ${corners[i]} is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not the clear color`;
            }
        }
        const y = Math.floor(height / 2);
        const left = pixels[y * width + Math.floor(width / 4)] & 0xFFFFFF;
        const right = pixels[y * width + Math.floor(width * 3 / 4)] & 0xFFFFFF;
        console.log(`Left center ${left & 0xFF}, ${(left >> 8) & 0xFF}, ${(left >> 16) & 0xFF}; right center ${right & 0xFF}, ${(right >> 8) & 0xFF}, ${(right >> 16) & 0xFF}`);
        if (left == background || right == background) {
            return "a half has no triangle in the middle";
        }
        const leftGreen = (left >> 8) & 0xFF;
        const rightGreen = (right >> 8) & 0xFF;
        if (leftGreen == 255) {
            return "the left triangle's center has green at 1: not PSMain";
        }
        if (rightGreen != 255) {
            return "the right triangle's center doesn't have green at 1: not PSMain2";
        }
        if ((left & 0xFF) != (right & 0xFF) || ((left >> 16) & 0xFF) != ((right >> 16) & 0xFF)) {
            return "the two triangles' red and blue differ";
        }
        return "";
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("generic_programs");

        // -test [-testOutput <file>]: render a few frames without a window and check the last one
        // (see checkFrame).
        const args = new Args(argc, argv, TEST_FRAMES);
        args.parseArgs();

        // The sample's window. Generic programs are D3D12's.
        if (args.api != GraphicsAPI.D3D12) {
            console.log("The Generic Programs example can only run on D3D12 API.");
            return 1;
        }
        // UNORM back buffers, as the sample's R8G8B8A8_UNORM.
        const options = AppOptions.UnormBackBuffer | args.options;
        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        if (app.getD3D12ShaderModel() < SHADER_MODEL_6_8) {
            app.destroy();
            return unsupported(args.test, "Generic Programs require a device with shader model 6.8 support (though the shaders used don't have be 6.8 shaders).");
        }

        const pass = new GenericProgramsPass(app);
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
        app.waitForIdle();
        pass.releasePrograms();
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return GenericPrograms.main(argc, argv);
}

// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, unsupported } from "../core/test_check";

namespace RaytracingHelloWorld {
    const WINDOW_TITLE = "D3D12 Raytracing - Hello World";

    // sizeof(RayPayload): float4 color; sizeof(BuiltInTriangleIntersectionAttributes); primary rays
    // only.
    const PAYLOAD_SIZE = 16;
    const ATTRIBUTE_SIZE = 8;
    const MAX_RECURSION_DEPTH = 1;

    // RayGenConstantBuffer: two Viewports (left, top, right, bottom); constant buffers are 256-byte
    // multiples.
    const CB_SIZE = 256;

    // BuildGeometry's triangle, in screen space (y down): its vertices counterclockwise there,
    // clockwise in left-handed coordinates, at depth 1.
    const DEPTH_VALUE = 1.0;
    const OFFSET = 0.7;
    const VERTEX_STRIDE = 12;

    // Test mode: the frames rendered.
    const TEST_FRAMES = 60;

    // Port of DirectX-Graphics-Samples' D3D12RaytracingHelloWorld: one triangle ray traced in
    // screen space with DXR / Vulkan ray tracing. The ray generation shader shoots orthographic rays
    // along z from the pixels inside a stencil window (the frame less a 10% border on its shorter
    // side); the hit triangle shows the hit's barycentrics, the rest of the window is the miss
    // shader's black. Outside the window the pixels show their dispatch coordinates (red across,
    // green down). The sample's local root constants (the viewport and the stencil window) are a
    // constant buffer here; its output texture is copied into the back buffer, as the sample's.
    class RaytracingHelloWorldPass {
        private app: App;
        private bindingLayout: BindingLayoutHandle;
        private bindingSet: BindingSet;
        private shaderTable: ShaderTable;
        private topLevelAS: SceneAccelStructs;
        private topLevelASBuilt: boolean;
        private triangleBlas: TriangleBlas;
        private vertexBuffer: BufferHandle;
        private indexBuffer: BufferHandle;
        private rayGenConstantBuffer: BufferHandle;
        private output: TextureHandle | null;
        private rayGenData: f32[];

        constructor(app: App) {
            this.app = app;
            this.bindingSet = new BindingSet(null);
            this.topLevelASBuilt = false;
            this.output = null;
            this.rayGenData = [];
            for (let i = 0; i < CB_SIZE / 4; i++) {
                this.rayGenData.push(0.0);
            }
        }

        init() {
            // CreateRootSignatures' global root signature (the output UAV, the TLAS), and the local
            // one's constants (b0).
            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutAccelStruct(0);
            layoutDesc.layoutTextureUAV(0);
            layoutDesc.layoutConstantBuffer(0);
            this.bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.All);

            if (!this.createRayTracingPipeline()) {
                return false;
            }

            this.rayGenConstantBuffer = this.app.createConstantBuffer(CB_SIZE, "RayGenConstants");

            const commandList = this.app.createCommandList();
            commandList.open();
            const created = this.createAccelerationStructures(commandList);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);
            if (!created) {
                return false;
            }

            const pass = this.app.addPass();
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }

        // The output texture has the back buffers' size.
        onBackBufferResizing() {
            const bindingSet = this.bindingSet;
            if (!bindingSet.isNull()) {
                this.app.releaseResource(bindingSet.handle);
                this.bindingSet = new BindingSet(null);
            }
            const output = this.output;
            if (output) {
                this.app.releaseResource(output);
                this.output = null;
            }
        }

        onAnimate(elapsedSeconds: number) {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        // The constructor's viewport (-1, -1, 1, 1) and UpdateForSizeChange's stencil window: a
        // border of 0.1 on the shorter side, as much in pixels on the longer one (float32 math).
        writeRayGenConstants(width: int, height: int) {
            const border = Math.fround(0.1);
            const aspectRatio = Math.fround(Math.fround(width) / Math.fround(height));
            this.rayGenData[0] = -1.0;
            this.rayGenData[1] = -1.0;
            this.rayGenData[2] = 1.0;
            this.rayGenData[3] = 1.0;
            if (width <= height) {
                const y = Math.fround(border * aspectRatio);
                this.rayGenData[4] = Math.fround(-1.0 + border);
                this.rayGenData[5] = Math.fround(-1.0 + y);
                this.rayGenData[6] = Math.fround(1.0 - border);
                this.rayGenData[7] = Math.fround(1.0 - y);
            } else {
                const x = Math.fround(border / aspectRatio);
                this.rayGenData[4] = Math.fround(-1.0 + x);
                this.rayGenData[5] = Math.fround(-1.0 + border);
                this.rayGenData[6] = Math.fround(1.0 - x);
                this.rayGenData[7] = Math.fround(1.0 - border);
            }
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const commandList = frame.getCommandList();
            const width = frame.getWidth();
            const height = frame.getHeight();

            let output = this.output;
            let bindingSet = this.bindingSet;
            if (!output || bindingSet.isNull()) {
                // The output the ray generation shader writes: UNORM, in the back buffer's channel
                // order, for the copy below.
                output = this.app.createUAVTextureForFrameCopy(frame, "RaytracingOutput");

                const bindingSetDesc = BindingSetDesc.create();
                bindingSetDesc.bindAccelStruct(0, this.topLevelAS.getTopLevelAS());
                bindingSetDesc.bindTextureUAV(0, output);
                bindingSetDesc.bindConstantBuffer(0, this.rayGenConstantBuffer, 0, CB_SIZE);
                bindingSet = this.app.createBindingSetForLayout(bindingSetDesc, this.bindingLayout);

                this.output = output;
                this.bindingSet = bindingSet;
            }

            // Its instance doesn't move: built once.
            if (!this.topLevelASBuilt) {
                frame.buildTopLevelAS(this.topLevelAS);
                this.topLevelASBuilt = true;
            }

            // DoRaytracing: the window's constants, then a ray per pixel.
            this.writeRayGenConstants(width, height);
            commandList.writeBuffer(this.rayGenConstantBuffer, Ref(this.rayGenData[0]), CB_SIZE);
            frame.dispatchRays(this.shaderTable, bindingSet, width, height);

            // CopyRaytracingOutputToBackbuffer: without conversion, as the sample's CopyResource
            // into its UNORM back buffer.
            frame.copyTextureToFrame(output);
        }

        // BuildGeometry and BuildAccelerationStructures: the triangle's vertex and 16-bit index
        // buffers, its BLAS (opaque, preferring fast tracing) and the TLAS's one instance (identity
        // transform).
        createAccelerationStructures(commandList: CommandList) {
            const offset = Math.fround(OFFSET);
            const vertices: f32[] = [
                0.0, -offset, DEPTH_VALUE,
                -offset, offset, DEPTH_VALUE,
                offset, offset, DEPTH_VALUE,
            ];
            // The indices 0, 1, 2: two 16-bit indices per int.
            const indices: int[] = [0 | (1 << 16), 2];
            this.vertexBuffer = this.app.createAccelStructInputStructuredBuffer(VERTEX_STRIDE, 3, "VertexBuffer");
            this.indexBuffer = this.app.createAccelStructInputRawBuffer(indices.length * 4, "IndexBuffer");
            commandList.writeBuffer(this.vertexBuffer, Ref(vertices[0]), vertices.length * 4);
            commandList.writeBuffer(this.indexBuffer, Ref(indices[0]), indices.length * 4);

            const triangleBlas = this.app.createEmptyTriangleBlas("BottomLevelAccelerationStructure");
            triangleBlas.addGeometry16(this.indexBuffer, 0, 3, this.vertexBuffer, 0, 3, VERTEX_STRIDE, null);
            if (triangleBlas.build(this.app, commandList, AccelStructBuildFlags.PreferFastTrace) == 0) {
                return false;
            }
            this.triangleBlas = triangleBlas;

            this.topLevelAS = this.app.createTopLevelASWithFlags(1, AccelStructBuildFlags.PreferFastTrace);
            if (this.topLevelAS.isNull()) {
                return false;
            }
            const transform: f32[] = [
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0,
            ];
            this.topLevelAS.addInstanceWithHitGroup(triangleBlas.getAccelStruct(), 1, 0, 0, 0, Ref(transform[0]));
            return true;
        }

        // CreateRaytracingPipelineStateObject and BuildShaderTables: the ray generation shader, the
        // miss shader, the hit group of the closest hit shader.
        createRayTracingPipeline() {
            const shaderLibrary = this.app.createShaderLibrary("raytracing_hello_world.hlsl");
            if (!shaderLibrary) {
                return false;
            }
            const pipelineDesc = RtPipelineDesc.create(PAYLOAD_SIZE, MAX_RECURSION_DEPTH);
            pipelineDesc.setMaxAttributeSize(ATTRIBUTE_SIZE);
            pipelineDesc.addGlobalBindingLayout(this.bindingLayout);
            pipelineDesc.addShader(shaderLibrary, "MyRaygenShader", ShaderType.RayGeneration);
            pipelineDesc.addShader(shaderLibrary, "MyMissShader", ShaderType.Miss);
            pipelineDesc.addHitGroup(shaderLibrary, "MyHitGroup", "MyClosestHitShader", "", null);
            const pipeline = this.app.createRayTracingPipelineFromDesc(pipelineDesc);
            if (!pipeline) {
                return false;
            }

            const shaderTable = this.app.createEmptyShaderTable(pipeline);
            // The shader table keeps the pipeline alive.
            this.app.releaseResource(pipeline);
            shaderTable.setRayGeneration("MyRaygenShader");
            shaderTable.addMiss("MyMissShader");
            shaderTable.addHitGroup("MyHitGroup", null);
            this.shaderTable = shaderTable;
            return true;
        }
    }

    // -test: checks the last frame. Outside the stencil window the corners show their dispatch
    // coordinates (black, red, green, yellow); inside it, the triangle's barycentrics (channels
    // summing to 255) over about a quarter of the frame, around the black the missed rays leave.
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        const failure = check.frameRead();
        if (failure != "") {
            return failure;
        }
        const w = check.width;
        const h = check.height;
        const expected = [0x000000, 0x0000FF, 0x00FF00, 0x00FFFF];
        const xs = [0, w - 1, 0, w - 1];
        const ys = [0, 0, h - 1, h - 1];
        for (let k = 0; k < 4; k++) {
            const p = check.rgb(xs[k], ys[k]);
            if (p != expected[k]) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}`;
            }
        }
        // The triangle: the stencil window's pixels whose channels sum to 255 (give or take the
        // rounding), with some color.
        const x0 = Math.floor(w / 10);
        const y0 = Math.floor(h / 10);
        let triangle = 0;
        let black = 0;
        for (let y = y0; y < h - y0; y++) {
            for (let x = x0; x < w - x0; x++) {
                const p = check.rgb(x, y);
                const sum = (p & 0xFF) + ((p >> 8) & 0xFF) + ((p >> 16) & 0xFF);
                if (sum >= 252 && sum <= 258) {
                    triangle++;
                } else if (p == 0) {
                    black++;
                }
            }
        }
        const center = check.rgb(Math.floor(w / 2), Math.floor(h / 2));
        if (center == 0) {
            return "the frame's center is black, not the triangle";
        }
        const triangleFailure = check.share(triangle, w * h, 20.0, 29.0, "Triangle");
        if (triangleFailure != "") {
            return triangleFailure;
        }
        return check.share(black, w * h, 25.0, 50.0, "Missed rays");
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Program.setAppName("raytracing_hello_world");

        // -test [-testOutput <file>]: render 60 frames without a window and check the last one (see
        // checkFrame).
        const args = new Args(argc, argv, TEST_FRAMES);
        args.parseArgs();

        // The sample's window.
        const options = AppOptions.RayTracing | args.options;
        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        if (!app.isFeatureSupported(Feature.RayTracingPipeline)) {
            app.destroy();
            return unsupported(args.test, "ERROR: DirectX Raytracing is not supported by your OS, GPU and/or driver.");
        }

        const pass = new RaytracingHelloWorldPass(app);
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
    return RaytracingHelloWorld.main(argc, argv);
}

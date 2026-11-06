// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, unsupported } from "../core/test_check";
import { formatFixed } from "../core/text_format";

namespace RaytracingHelloSer {
    const WINDOW_TITLE = "D3D12 Raytracing - Hello Shader Execution Reordering";

    // sizeof(RayPayload): float4 color, uint iterations; sizeof(BuiltInTriangleIntersectionAttributes);
    // primary rays only.
    const PAYLOAD_SIZE = 20;
    const ATTRIBUTE_SIZE = 8;
    const MAX_RECURSION_DEPTH = 1;

    // RayGenConstantBuffer: two Viewports (left, top, right, bottom); constant buffers are 256-byte
    // multiples.
    const CB_SIZE = 256;

    // BuildGeometry's full screen quad: two triangles at depth 1, in screen space (y down).
    const DEPTH_VALUE = 1.0;
    const OFFSET = 1.0;
    const VERTEX_STRIDE = 12;
    const QUAD_INDICES = [0, 1, 2, 0, 3, 2];

    // Test mode: the frames rendered.
    const TEST_FRAMES = 60;

    // Port of DirectX-Graphics-Samples' D3D12RaytracingHelloShaderExecutionReordering: the Hello World
    // sample's screen-space ray tracing on a full screen quad, every ray doing artificial work in its
    // closest hit shader, and every fourth column of rays (rendered white) five times as much. The
    // rays are traced into hit objects (shader model 6.9's dx::HitObject; Vulkan:
    // SPV_NV_shader_invocation_reorder), the threads reordered by a one-bit hint (heavy or light
    // work), then the hit objects' shaders invoked: Shader Execution Reordering gathers the heavy rays
    // into the same waves. The title shows the rays per second; -noreorder runs without the reorder
    // to compare. The sample's local root constants (the viewport) are a constant buffer here; its
    // output texture is copied into the back buffer, as the sample's.
    class RaytracingHelloSerPass {
        private app: App;
        private bindingLayout: BindingLayoutHandle;
        private bindingSet: BindingSet;
        private shaderTable: ShaderTable;
        private topLevelAS: SceneAccelStructs;
        private topLevelASBuilt: boolean;
        private quadBlas: TriangleBlas;
        private vertexBuffer: BufferHandle;
        private indexBuffer: BufferHandle;
        private rayGenConstantBuffer: BufferHandle;
        private output: TextureHandle | null;
        private rayGenData: f32[];
        private reorder: boolean;
        private reorders: boolean;

        // CalculateFrameStats: frames counted over a second.
        private frameCount: int;
        private statsTime: number;
        private totalTime: number;
        private title: string;
        private width: int;
        private height: int;

        constructor(app: App, reorder: boolean) {
            this.app = app;
            this.reorder = reorder;
            this.reorders = false;
            this.bindingSet = new BindingSet(null);
            this.topLevelASBuilt = false;
            this.output = null;
            this.rayGenData = [];
            for (let i = 0; i < CB_SIZE / 4; i++) {
                this.rayGenData.push(0.0);
            }
            this.frameCount = 0;
            this.statsTime = 0.0;
            this.totalTime = 0.0;
            this.title = WINDOW_TITLE;
            this.width = 0;
            this.height = 0;
        }

        init() {
            // D3D12_FEATURE_DATA_D3D12_OPTIONS22's ShaderExecutionReorderingActuallyReorders
            // (Vulkan: the invocation reorder mode).
            this.reorders = this.app.getShaderExecutionReordering() == ShaderExecutionReordering.Reorders;

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

        // CalculateFrameStats: once a second, the frames per second and the rays per second (one
        // per pixel), and whether the device reorders.
        onAnimate(elapsedSeconds: number) {
            this.totalTime += elapsedSeconds;
            this.frameCount++;
            const diff = this.totalTime - this.statsTime;
            if (diff >= 1.0) {
                const fps = this.frameCount / diff;
                const megaRays = this.width * this.height * fps / 1e6;
                this.frameCount = 0;
                this.statsTime = this.totalTime;
                this.title = `${WINDOW_TITLE}    fps: ${formatFixed(fps, 2)}     ~MegaRays/s: ${formatFixed(megaRays, 2)}` +
                    `    reorder ${this.reorder ? "requested" : "off"}, device reports ShaderExecutionReorderingActuallyReorders=${this.reorders ? "TRUE" : "FALSE"}`;
            }
            this.app.setWindowTitle(this.title);
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const commandList = frame.getCommandList();
            const width = frame.getWidth();
            const height = frame.getHeight();
            this.width = width;
            this.height = height;

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

                // The constructor's viewport (-1, -1, 1, 1); the stencil window the constants
                // carry is unused here.
                this.rayGenData[0] = -1.0;
                this.rayGenData[1] = -1.0;
                this.rayGenData[2] = 1.0;
                this.rayGenData[3] = 1.0;
                commandList.writeBuffer(this.rayGenConstantBuffer, Ref(this.rayGenData[0]), CB_SIZE);
            }

            // Its instance doesn't move: built once.
            if (!this.topLevelASBuilt) {
                frame.buildTopLevelAS(this.topLevelAS);
                this.topLevelASBuilt = true;
            }

            // DoRaytracing: a ray per pixel.
            frame.dispatchRays(this.shaderTable, bindingSet, width, height);

            // CopyRaytracingOutputToBackbuffer: without conversion, as the sample's CopyResource
            // into its UNORM back buffer.
            frame.copyTextureToFrame(output);
        }

        // BuildGeometry and BuildAccelerationStructures: the quad's vertex and 16-bit index buffers,
        // its BLAS (opaque, preferring fast tracing) and the TLAS's one instance (identity
        // transform).
        createAccelerationStructures(commandList: CommandList) {
            const offset = OFFSET;
            const vertices: f32[] = [
                -offset, -offset, DEPTH_VALUE,
                -offset, offset, DEPTH_VALUE,
                offset, offset, DEPTH_VALUE,
                offset, -offset, DEPTH_VALUE,
            ];
            // Two 16-bit indices per int.
            const indices: int[] = [];
            for (let i = 0; i < QUAD_INDICES.length; i += 2) {
                indices.push(QUAD_INDICES[i] | (QUAD_INDICES[i + 1] << 16));
            }
            this.vertexBuffer = this.app.createAccelStructInputStructuredBuffer(VERTEX_STRIDE, 4, "VertexBuffer");
            this.indexBuffer = this.app.createAccelStructInputRawBuffer(indices.length * 4, "IndexBuffer");
            commandList.writeBuffer(this.vertexBuffer, Ref(vertices[0]), vertices.length * 4);
            commandList.writeBuffer(this.indexBuffer, Ref(indices[0]), indices.length * 4);

            const quadBlas = this.app.createEmptyTriangleBlas("BottomLevelAccelerationStructure");
            quadBlas.addGeometry16(this.indexBuffer, 0, QUAD_INDICES.length, this.vertexBuffer, 0, 4, VERTEX_STRIDE, null);
            if (quadBlas.build(this.app, commandList, AccelStructBuildFlags.PreferFastTrace) == 0) {
                return false;
            }
            this.quadBlas = quadBlas;

            this.topLevelAS = this.app.createTopLevelASWithFlags(1, AccelStructBuildFlags.PreferFastTrace);
            if (this.topLevelAS.isNull()) {
                return false;
            }
            const transform: f32[] = [
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0,
            ];
            this.topLevelAS.addInstanceWithHitGroup(quadBlas.getAccelStruct(), 1, 0, 0, 0, Ref(transform[0]));
            return true;
        }

        // CreateRaytracingPipelineStateObject and BuildShaderTables: the ray generation shader, the
        // miss shader, the hit group of the closest hit shader. The library is the sample's
        // Raytracing.hlsl as built with REQUEST_REORDER, or without it (-noreorder).
        createRayTracingPipeline() {
            const shaderLibrary = this.app.createShaderLibraryWithDefine("raytracing_hello_ser.hlsl", "REORDER", this.reorder ? "1" : "0");
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

    // -test: checks the last frame. Every fourth column (from the first) did the heavy work and is
    // white; the others show the quad's barycentrics (channels summing to 255). The top row is black,
    // as the sample's: its rays start on the quad's top edge (y = -1) and miss it.
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        const failure = check.frameRead();
        if (failure != "") {
            return failure;
        }
        const w = check.width;
        const h = check.height;
        let whiteColumns = 0;
        let barycentric = 0;
        let wrong = 0;
        for (let x = 0; x < w; x++) {
            if (check.rgb(x, 0) != 0) {
                return `the top row's pixel ${x} isn't black (a miss)`;
            }
        }
        for (let y = 1; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const p = check.rgb(x, y);
                if (x % 4 == 0) {
                    if (p == 0xFFFFFF) {
                        whiteColumns++;
                    } else {
                        wrong++;
                    }
                } else {
                    const sum = (p & 0xFF) + ((p >> 8) & 0xFF) + ((p >> 16) & 0xFF);
                    if (sum >= 252 && sum <= 258) {
                        barycentric++;
                    } else {
                        wrong++;
                    }
                }
            }
        }
        console.log(`Heavy-work pixels (white) ${whiteColumns}, barycentric ${barycentric}, others ${wrong}`);
        if (wrong > 0) {
            return `${wrong} pixels are neither a heavy ray's white nor a light ray's barycentrics`;
        }
        const whiteFailure = check.share(whiteColumns, w * h, 24.0, 25.1, "Heavy work (white)");
        if (whiteFailure != "") {
            return whiteFailure;
        }
        return check.share(barycentric, w * h, 74.0, 75.1, "Light work (barycentrics)");
    }

    class RaytracingHelloSerArgs extends Args {
        // -noreorder: hit objects without MaybeReorderThread (the sample's REQUEST_REORDER off).
        reorder = true;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                if (this[i] == "-noreorder") {
                    this.reorder = false;
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Program.setAppName("raytracing_hello_ser");

        // -test [-testOutput <file>]: render 60 frames without a window and check the last one (see
        // checkFrame).
        const args = new RaytracingHelloSerArgs(argc, argv, TEST_FRAMES);
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
        // Hit objects: shader model 6.9 on D3D12, VK_NV_ray_tracing_invocation_reorder on Vulkan.
        if (app.getShaderExecutionReordering() == ShaderExecutionReordering.None) {
            app.destroy();
            return unsupported(args.test, "ERROR: Device doesn't support Shader Model 6.9.");
        }

        const pass = new RaytracingHelloSerPass(app, args.reorder);
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
    return RaytracingHelloSer.main(argc, argv);
}

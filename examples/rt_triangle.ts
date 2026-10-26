// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, unsupported } from "../core/test_check";

namespace RtTriangle {
    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // -test: checks the last frame. The top corners are the gray clear color; the ray traced
    // triangle covers half the frame, colored in the middle.
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        if (check.frameRead() != "") {
            return check.frameRead();
        }
        const total = check.width * check.height;
        if (check.rgb(0, 0) != 0x7C7C7C || check.rgb(check.width - 1, 0) != 0x7C7C7C) {
            return "the top corners aren't the clear color";
        }
        if (check.rgb(check.width / 2, check.height / 2) == 0x7C7C7C) {
            return "no triangle in the middle";
        }
        return check.share(check.countOtherThan(0x7C7C7C, 0, 0, check.width, check.height), total, 40.0, 60.0, "Triangle");
    }

    const WINDOW_TITLE = "Donut Example: Ray Traced Triangle";

    // sizeof(float4) of the HitInfo payload in rt_triangle.hlsl.
    const PAYLOAD_SIZE = 16;
    const UINT_SIZE = 4;
    const FLOAT3_SIZE = 12;

    // --- Passes -----------------------------------------------------------------------------

    // Port of Donut-Samples' rt_triangle.cpp.
    class RayTracedTrianglePass {
        private app: App;
        private shaderLibrary: ShaderLibraryHandle;
        private bindingLayout: BindingLayoutHandle;
        private shaderTable: ShaderTable;
        // Kept alive for as long as the TLAS: only the D3D12 backend of NVRHI references it from there.
        private bottomLevelAS: AccelStructHandle;
        private topLevelAS: AccelStructHandle;
        // Created on the first frame (they depend on the framebuffer size), dropped on resize.
        private renderTarget: TextureHandle | null;
        private bindingSet: BindingSet;

        constructor(app: App) {
            this.app = app;
            this.renderTarget = null;
            this.bindingSet = new BindingSet(null);
        }

        init() {
            this.shaderLibrary = this.app.createShaderLibrary("rt_triangle.hlsl");
            if (!this.shaderLibrary) {
                return false;
            }

            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutAccelStruct(0);
            layoutDesc.layoutTextureUAV(0);
            this.bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.All);

            const pipeline = this.app.createRayTracingPipeline(this.shaderLibrary, this.bindingLayout,
                "RayGen", "Miss", "HitGroup", "ClosestHit", PAYLOAD_SIZE);
            if (!pipeline) {
                return false;
            }

            this.shaderTable = this.app.createShaderTable(pipeline, "RayGen", "HitGroup", "Miss");
            // The shader table keeps the pipeline alive.
            this.app.releaseResource(pipeline);

            // Donut's common passes (the blit's), made before a command list is open, as the sample
            // makes them: they upload their textures with an immediate command list of their own.
            this.app.getCommonSampler(CommonSampler.LinearClamp);

            const commandList = this.app.createCommandList();
            commandList.open();

            const indexBuffer = this.app.createAccelStructInputBuffer(UINT_SIZE * 3, "IndexBuffer");
            const vertexBuffer = this.app.createAccelStructInputBuffer(FLOAT3_SIZE * 3, "VertexBuffer");

            const indices: int[] = [0, 1, 2];
            commandList.writeBuffer(indexBuffer, Ref(indices[0]), UINT_SIZE * 3);
            const vertices: f32[] = [0.0, -1.0, 1.0,   -1.0, 1.0, 1.0,   1.0, 1.0, 1.0];
            commandList.writeBuffer(vertexBuffer, Ref(vertices[0]), FLOAT3_SIZE * 3);

            this.bottomLevelAS = this.app.buildTriangleBLAS(commandList, indexBuffer, 3, vertexBuffer, 3);
            this.topLevelAS = this.app.buildSingleInstanceTLAS(commandList, this.bottomLevelAS);

            commandList.close();
            this.app.executeCommandList(commandList);

            // Only needed for the builds: the command list references them, and the app holds it
            // until the GPU is done with it.
            this.app.releaseResource(indexBuffer);
            this.app.releaseResource(vertexBuffer);
            this.app.releaseResource(commandList.handle);

            const pass = this.app.addPass();
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setAnimateCallback(this.onAnimate);
            pass.setRenderCallback(this.onRender);
            return true;
        }

        onBackBufferResizing() {
            const bindingSet = this.bindingSet;
            if (!bindingSet.isNull()) {
                this.app.releaseResource(bindingSet.handle);
                this.bindingSet = new BindingSet(null);
            }

            const renderTarget = this.renderTarget;
            if (renderTarget) {
                this.app.releaseResource(renderTarget);
                this.renderTarget = null;
            }

            // The blit's cached binding sets still reference the old render target.
            this.app.clearBindingCache();
        }

        onAnimate(elapsedSeconds: number) {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            let renderTarget = this.renderTarget;
            let bindingSet = this.bindingSet;
            if (!renderTarget || bindingSet.isNull()) {
                renderTarget = this.app.createUAVTextureForFrame(frame, "RenderTarget");

                const bindingSetDesc = BindingSetDesc.create();
                bindingSetDesc.bindAccelStruct(0, this.topLevelAS);
                bindingSetDesc.bindTextureUAV(0, renderTarget);
                bindingSet = this.app.createBindingSetForLayout(bindingSetDesc, this.bindingLayout);

                this.renderTarget = renderTarget;
                this.bindingSet = bindingSet;
            }

            frame.dispatchRays(this.shaderTable, bindingSet, frame.getWidth(), frame.getHeight());
            this.app.blitTexture(frame, renderTarget);
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Program.setAppName("rt_triangle");

        const args = new Args(argc, argv, TEST_FRAMES);
        args.parseArgs();

        const options = AppOptions.RayTracing | args.options;

        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        if (!app.isFeatureSupported(Feature.RayTracingPipeline)) {
            app.destroy();
            return unsupported(args.test, "The graphics device does not support Ray Tracing Pipelines");
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const rayTracing = new RayTracedTrianglePass(app);
        if (!rayTracing.init()) {
            console.log("Cannot initialize the ray tracing pipeline");
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
    return RtTriangle.main(argc, argv);
}

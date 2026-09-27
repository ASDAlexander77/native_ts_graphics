// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace RtTriangle {
    const WINDOW_TITLE = "Donut Example: Ray Traced Triangle";

    // sizeof(float4) of the HitInfo payload in rt_triangle.hlsl.
    const PAYLOAD_SIZE = 16;
    const UINT_SIZE = 4;
    const FLOAT3_SIZE = 12;

    // --- Passes -----------------------------------------------------------------------------

    // Port of Donut-Samples' rt_triangle.cpp.
    class RayTracedTrianglePass {
        private app: App;
        private shaderLibrary: Opaque;
        private bindingLayout: Opaque;
        private shaderTable: ShaderTable;
        // Kept alive for as long as the TLAS: only the D3D12 backend of NVRHI references it from there.
        private bottomLevelAS: Opaque;
        private topLevelAS: Opaque;
        // Created on the first frame (they depend on the framebuffer size), dropped on resize.
        private renderTarget: Opaque | null;
        private bindingSet: BindingSet;

        constructor(app: App) {
            this.app = app;
            this.renderTarget = null;
            this.bindingSet = new BindingSet(null);
        }

        onBackBufferResizing(): void {
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

        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        onRender(frameHandle: Opaque): void {
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

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
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

            const commandList = this.app.createCommandList();
            commandList.open();

            const indexBuffer = this.app.createAccelStructInputBuffer(UINT_SIZE * 3, "IndexBuffer");
            const vertexBuffer = this.app.createAccelStructInputBuffer(FLOAT3_SIZE * 3, "VertexBuffer");

            // `let`, not `const`: tslang takes the address of the array's storage only for non-const arrays.
            let indices: int[] = [0, 1, 2];
            commandList.writeBuffer(indexBuffer, Ref(indices[0]), UINT_SIZE * 3);
            let vertices: f32[] = [0.0, -1.0, 1.0,   -1.0, 1.0, 1.0,   1.0, 1.0, 1.0];
            commandList.writeBuffer(vertexBuffer, Ref(vertices[0]), FLOAT3_SIZE * 3);

            this.bottomLevelAS = this.app.buildTriangleBLAS(commandList, indexBuffer, 3, vertexBuffer, 3);
            this.topLevelAS = this.app.buildSingleInstanceTLAS(commandList, this.bottomLevelAS);

            commandList.close();
            this.app.executeCommandList(commandList);

            // Only needed for the builds: NVRHI keeps everything a submitted command list uses alive
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
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("rt_triangle");

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, AppOptions.RayTracing);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        if (!app.isFeatureSupported(Feature.RayTracingPipeline)) {
            console.log("The graphics device does not support Ray Tracing Pipelines");
            app.destroy();
            return 1;
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
        app.destroy();
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return RtTriangle.main(argc, argv);
}

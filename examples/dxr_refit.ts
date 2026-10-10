// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace DxrRefit {
    const WINDOW_TITLE = "Donut Example: DXR Refit";

    // struct RayPayload { float3 color; } (the shadow rays' uint payload is smaller).
    const PAYLOAD_SIZE = 12;
    // One TraceRay() from the ray generation shader, one from the plane's closest hit shader.
    const MAX_RECURSION_DEPTH = 2;

    const UINT_SIZE = 4;
    const FLOAT3_SIZE = 12;
    const FLOAT4_SIZE = 16;

    // The tutorial's createTriangleVB and createPlaneVB, one after the other in one buffer.
    const TRIANGLE_VERTICES = [
        0.0, 1.0, 0.0,
        0.866, -0.5, 0.0,
        -0.866, -0.5, 0.0,
    ];
    const PLANE_VERTICES = [
        -100.0, -1.0, -2.0,
        100.0, -1.0, 100.0,
        -100.0, -1.0, 100.0,

        -100.0, -1.0, -2.0,
        100.0, -1.0, -2.0,
        100.0, -1.0, 100.0,
    ];

    // The tutorial's createConstantBuffers: the colors A, B, C of each instance's triangle corners.
    const INSTANCE_COLORS = [
        // Instance 0
        1.0, 0.0, 0.0, 1.0,
        1.0, 1.0, 0.0, 1.0,
        1.0, 0.0, 1.0, 1.0,
        // Instance 1
        0.0, 1.0, 0.0, 1.0,
        0.0, 1.0, 1.0, 1.0,
        1.0, 1.0, 0.0, 1.0,
        // Instance 2
        0.0, 0.0, 1.0, 1.0,
        1.0, 0.0, 1.0, 1.0,
        0.0, 1.0, 1.0, 1.0,
    ];

    // The tutorial's shader table hit entries, two per geometry (primary ray, shadow ray): the
    // triangle and the plane of instance 0, then the triangles of instances 1 and 2.
    const HIT_GROUPS = [
        "TriangleHitGroup", "ShadowHitGroup",
        "PlaneHitGroup", "ShadowHitGroup",
        "TriangleHitGroup", "ShadowHitGroup",
        "TriangleHitGroup", "ShadowHitGroup",
    ];
    // Each instance's first hit entry (instanceContributionToHitGroupIndex).
    const INSTANCE_HIT_GROUPS = [0, 4, 6];
    // Instances 1 and 2 stand at these x, rotating about y.
    const INSTANCE_X = [0.0, -2.0, 2.0];

    // The tutorial adds 0.005 radians a frame (unthrottled, so at any rate); here 0.005 per
    // 1/60 second.
    const ROTATION_STEP = 0.005;
    const STEPS_PER_SECOND = 60.0;

    // --- Passes -----------------------------------------------------------------------------

    // Port of NVIDIA's DXR tutorial 14 (Refit): the scene of tutorials 8-13 (a triangle and a
    // plane in one BLAS, two more triangle instances; per-instance colors; shadow rays from the
    // plane) whose TLAS is refitted in place (built with AllowUpdate, updated with PerformUpdate)
    // every frame as instances 1 and 2 rotate.
    class RefitPass {
        private app: App;
        private bindingLayout: Opaque;
        private shaderTable: ShaderTable;
        // The triangle and the plane, the triangle alone. Kept alive for as long as the TLAS: only
        // the D3D12 backend of NVRHI references them from there.
        private blases: TriangleBlas[];
        private topLevelAS: SceneAccelStructs;
        private colorBuffer: BufferHandle;
        // The BLAS builds' vertices and indices.
        private inputBuffers: BufferHandle[];
        // Created on the first frame (it has the frame's size), dropped on resize.
        private storageImage: Opaque | null;
        private bindingSet: BindingSet;
        // A row-major 3x4 instance transform.
        private transform: f32[];
        private rotation: number;
        private rotationStep: number;

        // -benchmark: 0.005 radians a frame, as the tutorial (for comparisons).
        benchmark: boolean;
        // -rebuild: build the TLAS anew every frame instead of refitting it.
        rebuild: boolean;

        constructor(app: App) {
            this.app = app;
            this.blases = [];
            this.inputBuffers = [];
            this.storageImage = null;
            this.bindingSet = new BindingSet(null);
            this.transform = [];
            for (let i = 0; i < 12; i++) {
                this.transform.push(0.0);
            }
            this.rotation = 0.0;
            this.rotationStep = 0.0;
            this.benchmark = false;
            this.rebuild = false;
        }

        // The storage image has the back buffers' size.
        onBackBufferResizing(): void {
            const bindingSet = this.bindingSet;
            if (!bindingSet.isNull()) {
                this.app.releaseResource(bindingSet.handle);
                this.bindingSet = new BindingSet(null);
            }
            const storageImage = this.storageImage;
            if (storageImage) {
                this.app.releaseResource(storageImage);
                this.storageImage = null;
            }
        }

        onAnimate(elapsedSeconds: number): void {
            this.rotationStep = this.benchmark ? ROTATION_STEP : ROTATION_STEP * STEPS_PER_SECOND * elapsedSeconds;
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        // The tutorial's buildTopLevelAS: instance 0 (the triangle and the plane) unmoved, instances
        // 1 and 2 (the triangle) rotated about y by `rotation`, then moved to x = -2 and 2;
        // translate(x) * eulerAngleY(rotation) in rows.
        addInstances(): void {
            const c = Math.cos(this.rotation);
            const s = Math.sin(this.rotation);
            for (let i = 0; i < 3; i++) {
                const rotated = i > 0;
                for (let j = 0; j < 12; j++) {
                    this.transform[j] = 0.0;
                }
                this.transform[0] = rotated ? c : 1.0;
                this.transform[2] = rotated ? s : 0.0;
                this.transform[3] = INSTANCE_X[i];
                this.transform[5] = 1.0;
                this.transform[8] = rotated ? -s : 0.0;
                this.transform[10] = rotated ? c : 1.0;
                // The instance ID picks the instance's colors in the triangle's closest hit shader.
                this.topLevelAS.addInstanceWithHitGroup(this.blases[rotated ? 1 : 0].getAccelStruct(), 0xFF, i,
                    INSTANCE_HIT_GROUPS[i], 0, Ref(this.transform[0]));
            }
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();

            let storageImage = this.storageImage;
            let bindingSet = this.bindingSet;
            if (!storageImage || bindingSet.isNull()) {
                // The output the ray generation shader writes: UNORM, in the back buffer's channel
                // order, for the copy below.
                storageImage = this.app.createUAVTextureForFrameCopy(frame, "Output");

                const bindingSetDesc = BindingSetDesc.create();
                bindingSetDesc.bindAccelStruct(0, this.topLevelAS.getTopLevelAS());
                bindingSetDesc.bindTextureUAV(0, storageImage);
                bindingSetDesc.bindEntireConstantBuffer(0, this.colorBuffer);
                bindingSet = this.app.createBindingSetForLayout(bindingSetDesc, this.bindingLayout);

                this.storageImage = storageImage;
                this.bindingSet = bindingSet;
            }

            // The tutorial's onFrameRender: refit the TLAS (built on the first frame), then step
            // the rotation.
            this.addInstances();
            if (this.rebuild) {
                frame.buildTopLevelAS(this.topLevelAS);
            } else {
                frame.updateTopLevelAS(this.topLevelAS);
            }
            this.rotation = Math.fround(this.rotation + Math.fround(this.rotationStep));

            frame.dispatchRays(this.shaderTable, bindingSet, width, height);

            // Without conversion, as the tutorial's CopyResource: the shader's sRGB-encoded UNORM
            // values become the sRGB back buffer's.
            frame.copyTextureToFrame(storageImage);
        }

        // The tutorial's createAccelerationStructures: one BLAS of the triangle and the plane, one
        // of the triangle alone (the tutorial's geometries have no index buffers; here they index
        // their vertices in order).
        createAccelerationStructures(commandList: CommandList): boolean {
            let vertices: f32[] = [];
            for (let i = 0; i < TRIANGLE_VERTICES.length; i++) {
                vertices.push(TRIANGLE_VERTICES[i]);
            }
            for (let i = 0; i < PLANE_VERTICES.length; i++) {
                vertices.push(PLANE_VERTICES[i]);
            }
            const triangleVertexCount = TRIANGLE_VERTICES.length / 3;
            const planeVertexCount = PLANE_VERTICES.length / 3;
            let indices: int[] = [];
            for (let i = 0; i < triangleVertexCount; i++) {
                indices.push(i);
            }
            for (let i = 0; i < planeVertexCount; i++) {
                indices.push(i);
            }

            const vertexBuffer = this.app.createAccelStructInputBuffer(vertices.length * 4, "VertexBuffer");
            const indexBuffer = this.app.createAccelStructInputBuffer(indices.length * UINT_SIZE, "IndexBuffer");
            commandList.writeBuffer(vertexBuffer, Ref(vertices[0]), vertices.length * 4);
            commandList.writeBuffer(indexBuffer, Ref(indices[0]), indices.length * UINT_SIZE);

            for (let b = 0; b < 2; b++) {
                const blas = this.app.createEmptyTriangleBlas(b == 0 ? "TriangleAndPlane" : "Triangle");
                blas.addGeometry(indexBuffer, 0, triangleVertexCount, vertexBuffer, 0, triangleVertexCount, FLOAT3_SIZE, null);
                if (b == 0) {
                    blas.addGeometry(indexBuffer, triangleVertexCount * UINT_SIZE, planeVertexCount, vertexBuffer,
                        triangleVertexCount * FLOAT3_SIZE, planeVertexCount, FLOAT3_SIZE, null);
                }
                if (blas.build(this.app, commandList, AccelStructBuildFlags.None) == 0) {
                    return false;
                }
                this.blases.push(blas);
            }

            this.inputBuffers.push(vertexBuffer);
            this.inputBuffers.push(indexBuffer);

            // Refittable: built with AllowUpdate.
            this.topLevelAS = this.app.createTopLevelASWithFlags(3, AccelStructBuildFlags.AllowUpdate);
            return !this.topLevelAS.isNull();
        }

        // The tutorial's createRtPipelineState and createShaderTable: the ray generation shader,
        // the primary and shadow miss shaders, the triangle, plane and shadow hit groups, and the
        // hit entries of HIT_GROUPS.
        createRayTracingPipeline(): boolean {
            const shaderLibrary = this.app.createShaderLibrary("dxr_refit.hlsl");
            if (!shaderLibrary) {
                return false;
            }
            const pipelineDesc = RtPipelineDesc.create(PAYLOAD_SIZE, MAX_RECURSION_DEPTH);
            pipelineDesc.addGlobalBindingLayout(this.bindingLayout);
            pipelineDesc.addShader(shaderLibrary, "rayGen", ShaderType.RayGeneration);
            pipelineDesc.addShader(shaderLibrary, "miss", ShaderType.Miss);
            pipelineDesc.addShader(shaderLibrary, "shadowMiss", ShaderType.Miss);
            pipelineDesc.addHitGroup(shaderLibrary, "TriangleHitGroup", "triangleChs", "", null);
            pipelineDesc.addHitGroup(shaderLibrary, "PlaneHitGroup", "planeChs", "", null);
            pipelineDesc.addHitGroup(shaderLibrary, "ShadowHitGroup", "shadowChs", "", null);
            const pipeline = this.app.createRayTracingPipelineFromDesc(pipelineDesc);
            if (!pipeline) {
                return false;
            }

            const shaderTable = this.app.createEmptyShaderTable(pipeline);
            // The shader table keeps the pipeline alive.
            this.app.releaseResource(pipeline);
            shaderTable.setRayGeneration("rayGen");
            shaderTable.addMiss("miss");
            shaderTable.addMiss("shadowMiss");
            for (let i = 0; i < HIT_GROUPS.length; i++) {
                shaderTable.addHitGroup(HIT_GROUPS[i], null);
            }
            this.shaderTable = shaderTable;
            return true;
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutAccelStruct(0);
            layoutDesc.layoutTextureUAV(0);
            layoutDesc.layoutConstantBuffer(0);
            this.bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.All);

            if (!this.createRayTracingPipeline()) {
                return false;
            }

            this.colorBuffer = this.app.createConstantBuffer(INSTANCE_COLORS.length * 4, "InstanceColors");

            const commandList = this.app.createCommandList();
            commandList.open();
            let colors: f32[] = [];
            for (let i = 0; i < INSTANCE_COLORS.length; i++) {
                colors.push(INSTANCE_COLORS[i]);
            }
            commandList.writeBuffer(this.colorBuffer, Ref(colors[0]), INSTANCE_COLORS.length / 4 * FLOAT4_SIZE);
            const created = this.createAccelerationStructures(commandList);
            commandList.close();
            this.app.executeCommandList(commandList);
            // Only needed for the builds: the command list references them, and the app holds it
            // until the GPU is done with it.
            for (let i = 0; i < this.inputBuffers.length; i++) {
                this.app.releaseResource(this.inputBuffers[i]);
            }
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
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("dxr_refit");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -benchmark: 0.005 radians a frame, as the tutorial.
        // -rebuild: build the TLAS anew every frame instead of refitting it.
        let options = AppOptions.RayTracing;
        let benchmark = false;
        let rebuild = false;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = options | AppOptions.DebugRuntime;
            } else if (arg == "-benchmark") {
                benchmark = true;
            } else if (arg == "-rebuild") {
                rebuild = true;
            }
        }

        // The tutorial's 1920 x 1200 aspect ratio, in a smaller window.
        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 800, options);
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

        const pass = new RefitPass(app);
        pass.benchmark = benchmark;
        pass.rebuild = rebuild;
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
    return DxrRefit.main(argc, argv);
}

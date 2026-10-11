// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import {
    cross3, matrixInverse, matrixLookAtLH, matrixMultiply, matrixPerspectiveFovLH, matrixRotationY, normalize3,
    normalize4, radians, transform3, vsub,
} from "../core/directx_math";

namespace RaytracingLibrarySubobjects {
    const WINDOW_TITLE = "D3D12 Raytracing - Library Subobjects";

    // The shaders and subobjects the state object takes from the library (CreateRaytracingPipelineStateObject's
    // DefineExport calls).
    const LIBRARY_EXPORTS = "MyRaygenShader,MyClosestHitShader,MyMissShader," +
        "MyGlobalRootSignature,MyLocalRootSignature,MyLocalRootSignatureAssociation,MyShaderConfig,MyPipelineConfig,MyHitGroup";
    // The global root signature's parameters (MyGlobalRootSignature) and the descriptors of its two
    // descriptor tables: the output's UAV, then the index and vertex buffers' SRVs.
    const OUTPUT_VIEW_SLOT = 0;
    const ACCELERATION_STRUCTURE_SLOT = 1;
    const SCENE_CONSTANT_SLOT = 2;
    const VERTEX_BUFFERS_SLOT = 3;
    const OUTPUT_DESCRIPTOR = 0;
    const INDEX_BUFFER_DESCRIPTOR = 1;
    const VERTEX_BUFFER_DESCRIPTOR = 2;
    const DESCRIPTOR_COUNT = 3;

    // SceneConstantBuffer: projectionToWorld (row-major), cameraPosition, lightPosition,
    // lightAmbientColor, lightDiffuseColor; CubeConstantBuffer: albedo.
    const SCENE_CB_FLOATS = 32;
    const CUBE_CB_FLOATS = 4;
    // Constant buffers are 256-byte multiples.
    const CB_SIZE = 256;

    // BuildGeometry's cube: 24 vertices (position, normal: 24 bytes each), a face's four with the
    // face's normal, and 36 16-bit indices.
    const VERTEX_STRIDE = 24;
    const CUBE_VERTICES = [
        -1.0, 1.0, -1.0, 0.0, 1.0, 0.0,
        1.0, 1.0, -1.0, 0.0, 1.0, 0.0,
        1.0, 1.0, 1.0, 0.0, 1.0, 0.0,
        -1.0, 1.0, 1.0, 0.0, 1.0, 0.0,

        -1.0, -1.0, -1.0, 0.0, -1.0, 0.0,
        1.0, -1.0, -1.0, 0.0, -1.0, 0.0,
        1.0, -1.0, 1.0, 0.0, -1.0, 0.0,
        -1.0, -1.0, 1.0, 0.0, -1.0, 0.0,

        -1.0, -1.0, 1.0, -1.0, 0.0, 0.0,
        -1.0, -1.0, -1.0, -1.0, 0.0, 0.0,
        -1.0, 1.0, -1.0, -1.0, 0.0, 0.0,
        -1.0, 1.0, 1.0, -1.0, 0.0, 0.0,

        1.0, -1.0, 1.0, 1.0, 0.0, 0.0,
        1.0, -1.0, -1.0, 1.0, 0.0, 0.0,
        1.0, 1.0, -1.0, 1.0, 0.0, 0.0,
        1.0, 1.0, 1.0, 1.0, 0.0, 0.0,

        -1.0, -1.0, -1.0, 0.0, 0.0, -1.0,
        1.0, -1.0, -1.0, 0.0, 0.0, -1.0,
        1.0, 1.0, -1.0, 0.0, 0.0, -1.0,
        -1.0, 1.0, -1.0, 0.0, 0.0, -1.0,

        -1.0, -1.0, 1.0, 0.0, 0.0, 1.0,
        1.0, -1.0, 1.0, 0.0, 0.0, 1.0,
        1.0, 1.0, 1.0, 0.0, 0.0, 1.0,
        -1.0, 1.0, 1.0, 0.0, 0.0, 1.0,
    ];
    const CUBE_INDICES = [
        3, 1, 0,
        2, 1, 3,

        6, 4, 5,
        7, 4, 6,

        11, 9, 8,
        10, 9, 11,

        14, 12, 13,
        15, 12, 14,

        19, 17, 16,
        18, 17, 19,

        22, 20, 21,
        23, 20, 22,
    ];

    // Test mode: the frames rendered, each 1/60 s.
    const TEST_FRAMES = 60;

    // Port of DirectX-Graphics-Samples' D3D12RaytracingLibrarySubobjects: the Simple Lighting
    // sample's ray traced cube (lit by green diffuse light here), its ray tracing state object made
    // of the DXIL library alone. The library's HLSL defines the subobjects that the application
    // otherwise creates: the global root signature (created from the library's bytecode too), the
    // local one with the cube's albedo as root constants and its association with the hit group,
    // the hit group, the shader config and the pipeline config. D3D12 only (DXIL subobjects),
    // through D3D12 directly for the state object, root arguments and DispatchRays.
    class RaytracingLibrarySubobjectsPass {
        private app: App;
        private pipeline: D3D12LibraryRtPipeline;
        private topLevelAS: SceneAccelStructs;
        private topLevelASBuilt: boolean;
        private cubeBlas: TriangleBlas;
        private vertexBuffer: BufferHandle;
        private indexBuffer: BufferHandle;
        private sceneConstantBuffer: BufferHandle;
        private output: TextureHandle | null;

        // InitializeScene's camera and light.
        private eye: number[];
        private at: number[];
        private up: number[];
        private lightPosition: number[];
        private sceneData: f32[];

        constructor(app: App) {
            this.app = app;
            this.topLevelASBuilt = false;
            this.output = null;
            this.eye = [];
            this.at = [];
            this.up = [];
            this.lightPosition = [0.0, Math.fround(1.8), -3.0, 0.0];
            this.sceneData = [];
            for (let i = 0; i < CB_SIZE / 4; i++) {
                this.sceneData.push(0.0);
            }
        }

        // The output texture has the back buffers' size.
        onBackBufferResizing(): void {
            const output = this.output;
            if (output) {
                this.app.releaseResource(output);
                this.output = null;
            }
        }

        // OnUpdate: the camera circles the cube about y once in 24 s, the light the other way once
        // in 8 s.
        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
            const elapsedTime = Math.fround(elapsedSeconds);
            {
                const angleToRotateBy = Math.fround(360.0 * Math.fround(elapsedTime / 24.0));
                const rotate = matrixRotationY(radians(angleToRotateBy));
                this.eye = transform3(this.eye, rotate);
                this.up = transform3(this.up, rotate);
                this.at = transform3(this.at, rotate);
            }
            {
                const angleToRotateBy = Math.fround(-360.0 * Math.fround(elapsedTime / 8.0));
                const rotate = matrixRotationY(radians(angleToRotateBy));
                this.lightPosition = transform3(this.lightPosition, rotate);
            }
        }

        // UpdateCameraMatrices: projectionToWorld, the inverse of the view-projection matrix
        // (45 degrees vertically, depth 1 to 125), and the camera position; the light.
        writeSceneConstants(width: int, height: int): void {
            const view = matrixLookAtLH(this.eye, this.at, this.up);
            const aspectRatio = Math.fround(Math.fround(width) / Math.fround(height));
            const proj = matrixPerspectiveFovLH(radians(45.0), aspectRatio, 1.0, 125.0);
            const projectionToWorld = matrixInverse(matrixMultiply(view, proj));
            for (let i = 0; i < 16; i++) {
                this.sceneData[i] = projectionToWorld[i];
            }
            for (let i = 0; i < 4; i++) {
                this.sceneData[16 + i] = this.eye[i];
                this.sceneData[20 + i] = this.lightPosition[i];
            }
            // lightAmbientColor (0.5, 0.5, 0.5, 1), lightDiffuseColor (0, 0.5, 0, 1).
            this.sceneData[24] = 0.5;
            this.sceneData[25] = 0.5;
            this.sceneData[26] = 0.5;
            this.sceneData[27] = 1.0;
            this.sceneData[28] = 0.0;
            this.sceneData[29] = 0.5;
            this.sceneData[30] = 0.0;
            this.sceneData[31] = 1.0;
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const commandList = frame.getCommandList();
            const width = frame.getWidth();
            const height = frame.getHeight();

            let output = this.output;
            if (!output) {
                // The output the ray generation shader writes: UNORM, in the back buffer's channel
                // order, for the copy below; its UAV in the output's descriptor table.
                output = this.app.createUAVTextureForFrameCopy(frame, "RaytracingOutput");
                this.app.setD3D12LibraryRtDescriptorTextureUAV(this.pipeline, OUTPUT_DESCRIPTOR, output);
                this.output = output;
            }

            // Its instance doesn't move: built once.
            if (!this.topLevelASBuilt) {
                frame.buildTopLevelAS(this.topLevelAS);
                this.topLevelASBuilt = true;
            }

            // DoRaytracing: the scene constants, then the rays.
            this.writeSceneConstants(width, height);
            commandList.writeBuffer(this.sceneConstantBuffer, Ref(this.sceneData[0]), CB_SIZE);
            commandList.dispatchD3D12LibraryRays(this.pipeline, width, height);

            // CopyRaytracingOutputToBackbuffer: without conversion, as the sample's CopyResource
            // into its UNORM back buffer.
            frame.copyTextureToFrame(output);
        }

        // BuildGeometry and BuildAccelerationStructures: the cube's vertex and index buffers (which
        // the closest hit shader reads too), its BLAS (opaque, preferring fast tracing) and the
        // TLAS's one instance (identity transform).
        createAccelerationStructures(commandList: CommandList): boolean {
            let vertices: f32[] = [];
            for (let i = 0; i < CUBE_VERTICES.length; i++) {
                vertices.push(CUBE_VERTICES[i]);
            }
            // Two 16-bit indices per int.
            let indices: int[] = [];
            for (let i = 0; i < CUBE_INDICES.length; i += 2) {
                indices.push(CUBE_INDICES[i] | (CUBE_INDICES[i + 1] << 16));
            }
            const vertexCount = CUBE_VERTICES.length / 6;
            this.vertexBuffer = this.app.createAccelStructInputStructuredBuffer(VERTEX_STRIDE, vertexCount, "VertexBuffer");
            this.indexBuffer = this.app.createAccelStructInputRawBuffer(CUBE_INDICES.length * 2, "IndexBuffer");
            commandList.writeBuffer(this.vertexBuffer, Ref(vertices[0]), vertices.length * 4);
            commandList.writeBuffer(this.indexBuffer, Ref(indices[0]), CUBE_INDICES.length * 2);

            const cubeBlas = this.app.createEmptyTriangleBlas("CubeBLAS");
            cubeBlas.addGeometry16(this.indexBuffer, 0, CUBE_INDICES.length, this.vertexBuffer, 0, vertexCount, VERTEX_STRIDE, null);
            if (cubeBlas.build(this.app, commandList, AccelStructBuildFlags.PreferFastTrace) == 0) {
                return false;
            }
            this.cubeBlas = cubeBlas;

            this.topLevelAS = this.app.createTopLevelASWithFlags(1, AccelStructBuildFlags.PreferFastTrace);
            if (this.topLevelAS.isNull()) {
                return false;
            }
            let transform: f32[] = [
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0,
            ];
            this.topLevelAS.addInstanceWithHitGroup(cubeBlas.getAccelStruct(), 1, 0, 0, 0, Ref(transform[0]));
            return true;
        }

        // CreateRootSignatures, CreateRaytracingPipelineStateObject and BuildShaderTables: the
        // global root signature and the state object from the library's subobjects; the shader
        // table's records: the ray generation shader, the miss shader, and the hit group with the
        // cube's albedo as its local root constants (white). Then the global root signature's
        // arguments.
        createRayTracingPipeline(): boolean {
            const shaderLibrary = this.app.createShaderLibrary("raytracing_library_subobjects.hlsl");
            if (!shaderLibrary) {
                return false;
            }
            const pipeline = this.app.createD3D12LibraryRtPipeline(shaderLibrary, LIBRARY_EXPORTS, DESCRIPTOR_COUNT);
            if (pipeline.isNull()) {
                return false;
            }
            this.pipeline = pipeline;

            let cubeConstants: f32[] = [1.0, 1.0, 1.0, 1.0];
            if (this.app.setD3D12LibraryRtShaderTable(pipeline, "MyRaygenShader", "MyMissShader", "MyHitGroup",
                Ref(cubeConstants[0]), CUBE_CB_FLOATS * 4) == 0) {
                return false;
            }

            this.app.setD3D12LibraryRtDescriptorBufferSRV(pipeline, INDEX_BUFFER_DESCRIPTOR, this.indexBuffer, 0);
            this.app.setD3D12LibraryRtDescriptorBufferSRV(pipeline, VERTEX_BUFFER_DESCRIPTOR, this.vertexBuffer, VERTEX_STRIDE);
            pipeline.setRootDescriptorTable(OUTPUT_VIEW_SLOT, OUTPUT_DESCRIPTOR);
            pipeline.setRootAccelStruct(ACCELERATION_STRUCTURE_SLOT, this.topLevelAS.getTopLevelAS());
            pipeline.setRootConstantBuffer(SCENE_CONSTANT_SLOT, this.sceneConstantBuffer);
            pipeline.setRootDescriptorTable(VERTEX_BUFFERS_SLOT, INDEX_BUFFER_DESCRIPTOR);
            return true;
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            // InitializeScene's camera: from (0, 2, -5) towards the origin, its up vector
            // perpendicular to the view direction and x, both turned 45 degrees about y.
            this.eye = [0.0, 2.0, -5.0, 1.0];
            this.at = [0.0, 0.0, 0.0, 1.0];
            const direction = normalize4(vsub(this.at, this.eye));
            this.up = normalize3(cross3(direction, [1.0, 0.0, 0.0, 0.0]));
            const rotate = matrixRotationY(radians(45.0));
            this.eye = transform3(this.eye, rotate);
            this.up = transform3(this.up, rotate);

            // A static constant buffer, written in the frames' command lists.
            this.sceneConstantBuffer = this.app.createConstantBuffer(CB_SIZE, "SceneConstants");

            const commandList = this.app.createCommandList();
            commandList.open();
            const created = this.createAccelerationStructures(commandList);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);
            if (!created || !this.createRayTracingPipeline()) {
                return false;
            }

            const pass = this.app.addPass();
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // -test: checks the last frame. The background (the miss shader's (0, 0.2, 0.4)) around the
    // cube in the middle; the cube's faces ambient gray (0.5) at least, the lit ones greened by
    // the diffuse light.
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
        const corner = pixels[0] & 0xFFFFFF;
        if (corner != background) {
            return `the corner pixel is ${corner & 0xFF}, ${(corner >> 8) & 0xFF}, ${(corner >> 16) & 0xFF}, not the background`;
        }
        const center = pixels[Math.floor(height / 2) * width + Math.floor(width / 2)] & 0xFFFFFF;
        if (center == background) {
            return "the frame's center shows the background, not the cube";
        }
        let cube = 0;
        let greened = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i] & 0xFFFFFF;
            if (p == background) {
                continue;
            }
            cube++;
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            if (g > r + 16) {
                greened++;
            }
        }
        const coverage = cube / (width * height);
        const greenedFraction = greened / (width * height);
        console.log(`Coverage ${coverage}, greened ${greenedFraction}`);
        if (coverage < 0.05 || coverage > 0.6) {
            return `the cube covers ${coverage} of the frame`;
        }
        if (greenedFraction < 0.01) {
            return `only ${greenedFraction} of the frame is lit by the green diffuse light`;
        }
        return "";
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("raytracing_library_subobjects");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -test [-testOutput <file>]: render 60 frames (at 60 a second) without a window and check
        // the last one (see checkFrame).
        let options = AppOptions.RayTracing;
        for (let i = 1; i < argc; i++) {
            if (Donut_GetArg(argv, i) == "-debug") {
                options = options | AppOptions.DebugRuntime;
            }
        }
        const test = Donut_ParseTestArgs(argc, argv, TEST_FRAMES, 1.0 / 60.0) != 0;

        // The sample's window. Library subobjects are DXIL's: D3D12 only.
        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        if (api != GraphicsAPI.D3D12) {
            console.log("The Raytracing Library Subobjects example can only run on D3D12 API.");
            return 1;
        }
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        if (!app.isFeatureSupported(Feature.RayTracingPipeline)) {
            console.log("The graphics device does not support Ray Tracing Pipelines");
            app.destroy();
            return 1;
        }

        const pass = new RaytracingLibrarySubobjectsPass(app);
        if (!pass.init()) {
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        let result = 0;
        if (test) {
            result = app.finishTest(checkFrame(app));
        }
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return RaytracingLibrarySubobjects.main(argc, argv);
}

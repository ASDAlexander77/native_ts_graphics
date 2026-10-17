// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import {
    cross3, matrixInverse, matrixLookAtLH, matrixMultiply, matrixPerspectiveFovLH, matrixRotationY, normalize3,
    normalize4, radians, transform3, vsub,
} from "../core/directx_math";
import { unsupported } from "../core/test_check";

namespace RaytracingSimpleLighting {
    const WINDOW_TITLE = "D3D12 Raytracing - Simple Lighting";

    // sizeof(RayPayload): float4 color; sizeof(BuiltInTriangleIntersectionAttributes); primary rays
    // only.
    const PAYLOAD_SIZE = 16;
    const ATTRIBUTE_SIZE = 8;
    const MAX_RECURSION_DEPTH = 1;

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

    // Port of DirectX-Graphics-Samples' D3D12RaytracingSimpleLighting: a cube ray traced with
    // DXR / Vulkan ray tracing, lit by a point light (ambient plus red diffuse light), the
    // camera circling it once in 24 s and the light the other way once in 8 s. The closest hit
    // shader finds the hit triangle's vertex normals through its 16-bit indices, read from a
    // ByteAddressBuffer, and interpolates them with the hit's barycentrics. The sample's local
    // root constants (the cube's albedo) are a constant buffer here; its output texture is copied
    // into the back buffer, as the sample's.
    class RaytracingSimpleLightingPass {
        private app: App;
        private bindingLayout: BindingLayoutHandle;
        private bindingSet: BindingSet;
        private shaderTable: ShaderTable;
        private topLevelAS: SceneAccelStructs;
        private topLevelASBuilt: boolean;
        private cubeBlas: TriangleBlas;
        private vertexBuffer: BufferHandle;
        private indexBuffer: BufferHandle;
        private sceneConstantBuffer: BufferHandle;
        private cubeConstantBuffer: BufferHandle;
        private output: TextureHandle | null;

        // InitializeScene's camera and light.
        private eye: number[];
        private at: number[];
        private up: number[];
        private lightPosition: number[];
        private sceneData: f32[];
        private cubeData: f32[];

        constructor(app: App) {
            this.app = app;
            this.bindingSet = new BindingSet(null);
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
            this.cubeData = [];
            for (let i = 0; i < CB_SIZE / 4; i++) {
                this.cubeData.push(0.0);
            }
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

        // OnUpdate: the camera circles the cube about y once in 24 s, the light the other way once
        // in 8 s.
        onAnimate(elapsedSeconds: number) {
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
        writeSceneConstants(width: int, height: int) {
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
            // lightAmbientColor (0.5, 0.5, 0.5, 1), lightDiffuseColor (0.5, 0, 0, 1).
            this.sceneData[24] = 0.5;
            this.sceneData[25] = 0.5;
            this.sceneData[26] = 0.5;
            this.sceneData[27] = 1.0;
            this.sceneData[28] = 0.5;
            this.sceneData[29] = 0.0;
            this.sceneData[30] = 0.0;
            this.sceneData[31] = 1.0;
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
                bindingSetDesc.bindRawBufferSRV(1, this.indexBuffer);
                bindingSetDesc.bindStructuredBufferSRV(2, this.vertexBuffer);
                bindingSetDesc.bindConstantBuffer(0, this.sceneConstantBuffer, 0, CB_SIZE);
                bindingSetDesc.bindConstantBuffer(1, this.cubeConstantBuffer, 0, CB_SIZE);
                bindingSet = this.app.createBindingSetForLayout(bindingSetDesc, this.bindingLayout);

                this.output = output;
                this.bindingSet = bindingSet;
            }

            // Its instance doesn't move: built once.
            if (!this.topLevelASBuilt) {
                frame.buildTopLevelAS(this.topLevelAS);
                this.topLevelASBuilt = true;
            }

            // DoRaytracing: the scene constants, then the rays.
            this.writeSceneConstants(width, height);
            commandList.writeBuffer(this.sceneConstantBuffer, Ref(this.sceneData[0]), CB_SIZE);
            frame.dispatchRays(this.shaderTable, bindingSet, width, height);

            // CopyRaytracingOutputToBackbuffer: without conversion, as the sample's CopyResource
            // into its UNORM back buffer.
            frame.copyTextureToFrame(output);
        }

        // BuildGeometry and BuildAccelerationStructures: the cube's vertex and index buffers (which
        // the closest hit shader reads too), its BLAS (opaque, preferring fast tracing) and the
        // TLAS's one instance (identity transform).
        createAccelerationStructures(commandList: CommandList) {
            let vertices = CUBE_VERTICES.map((v): f32 => v);
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

        // CreateRaytracingPipelineStateObject and BuildShaderTables: the ray generation shader, the
        // miss shader, the hit group of the closest hit shader.
        createRayTracingPipeline() {
            const shaderLibrary = this.app.createShaderLibrary("raytracing_simple_lighting.hlsl");
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

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init() {
            // CreateRootSignatures' global root signature, and the local one's constants (b1).
            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutAccelStruct(0);
            layoutDesc.layoutTextureUAV(0);
            layoutDesc.layoutRawBufferSRV(1);
            layoutDesc.layoutStructuredBufferSRV(2);
            layoutDesc.layoutConstantBuffer(0);
            layoutDesc.layoutConstantBuffer(1);
            this.bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.All);

            if (!this.createRayTracingPipeline()) {
                return false;
            }

            // InitializeScene's camera: from (0, 2, -5) towards the origin, its up vector
            // perpendicular to the view direction and x, both turned 45 degrees about y.
            this.eye = [0.0, 2.0, -5.0, 1.0];
            this.at = [0.0, 0.0, 0.0, 1.0];
            const direction = normalize4(vsub(this.at, this.eye));
            this.up = normalize3(cross3(direction, [1.0, 0.0, 0.0, 0.0]));
            const rotate = matrixRotationY(radians(45.0));
            this.eye = transform3(this.eye, rotate);
            this.up = transform3(this.up, rotate);

            // Static constant buffers, written in the frames' command lists.
            this.sceneConstantBuffer = this.app.createConstantBuffer(CB_SIZE, "SceneConstants");
            this.cubeConstantBuffer = this.app.createConstantBuffer(CB_SIZE, "CubeConstants");
            // The cube's albedo: white.
            for (let i = 0; i < CUBE_CB_FLOATS; i++) {
                this.cubeData[i] = 1.0;
            }

            const commandList = this.app.createCommandList();
            commandList.open();
            commandList.writeBuffer(this.cubeConstantBuffer, Ref(this.cubeData[0]), CB_SIZE);
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
    }

    // -test: checks the last frame. The background (the miss shader's (0, 0.2, 0.4)) around the
    // cube in the middle; the cube's faces ambient gray (0.5) at least, the lit ones reddened by
    // the diffuse light.
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
        const corner = pixels[0] & 0xFFFFFF;
        if (corner != background) {
            return `the corner pixel is ${corner & 0xFF}, ${(corner >> 8) & 0xFF}, ${(corner >> 16) & 0xFF}, not the background`;
        }
        const center = pixels[Math.floor(height / 2) * width + Math.floor(width / 2)] & 0xFFFFFF;
        if (center == background) {
            return "the frame's center shows the background, not the cube";
        }
        let cube = 0;
        let reddened = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i] & 0xFFFFFF;
            if (p == background) {
                continue;
            }
            cube++;
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            if (r > g + 16) {
                reddened++;
            }
        }
        const coverage = cube / (width * height);
        const reddenedFraction = reddened / (width * height);
        console.log(`Coverage ${coverage}, reddened ${reddenedFraction}`);
        if (coverage < 0.05 || coverage > 0.6) {
            return `the cube covers ${coverage} of the frame`;
        }
        if (reddenedFraction < 0.01) {
            return `only ${reddenedFraction} of the frame is lit by the red diffuse light`;
        }
        return "";
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("raytracing_simple_lighting");

        // -test [-testOutput <file>]: render 60 frames (at 60 a second) without a window and check
        // the last one (see checkFrame).
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
            return unsupported(args.test, "The graphics device does not support Ray Tracing Pipelines");
        }

        const pass = new RaytracingSimpleLightingPass(app);
        if (!pass.init()) {
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        let result = 0;
        if (args.test) {
            result =app.finishTest(checkFrame(app));
        }
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return RaytracingSimpleLighting.main(argc, argv);
}

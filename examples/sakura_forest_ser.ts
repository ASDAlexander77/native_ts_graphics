// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { unsupported } from "../core/test_check";
import { ObjModel } from "../core/obj_model";
import {
    cross3, matrixInverse, matrixLookAtLH, matrixMultiply, matrixPerspectiveFovLH, matrixRotationAxis, matrixRotationY, normalize3,
    normalize4, radians, transform3, transformNormal3, vadd, vmul, vsub,
} from "../core/directx_math";

namespace SakuraForestSER {
    const WINDOW_TITLE = "D3D12 Raytracing - Sakura Scene";
    const WIDTH = 1280;
    const HEIGHT = 720;

    // The sample's files, from DIRECTX_GRAPHICS_SAMPLES_DIR.
    const MEDIA = "media/sakura_forest_ser/";
    const OBJ_FILES = ["trunk.obj", "leaves.obj", "bush.obj"];
    const TRUNK_TEXTURE = "tree-trunk.jpg";
    const BUSH_TEXTURE = "bush-texture.jpg";

    // The sample's SegoeUI_18 sprite font: OpenSans at the size whose strings are as wide (ImGui
    // sizes a font by its ascent + descent), and its line spacing.
    const FONT_PATH = "media/fonts/OpenSans/OpenSans-Regular.ttf";
    const FONT_SIZE = 31.5;
    const LINE_SPACING = 31.9;

    // The state object's shaders and subobjects, from the library (shaders/sakura_forest_ser.hlsl).
    const LIBRARY_EXPORTS = "MyRaygenShader,FloorClosestHitShader,TrunkClosestHitShader,LeavesClosestHitShader,BushClosestHitShader," +
        "TCubeClosestHitShader,MyMissShader,MyGlobalRootSignature,MyLocalRootSignature,MyLocalRootSignatureAssociation,MyShaderConfig," +
        "MyPipelineConfig,MyHitGroup,TrunkHitGroup,LeavesHitGroup,BushHitGroup,TCubeHitGroup";
    // The hit groups by material ID (ObjectConstantBuffer.materialID): floor cubes, reflective cubes,
    // trunks, leaves, bushes.
    const HIT_GROUPS = "MyHitGroup,TCubeHitGroup,TrunkHitGroup,LeavesHitGroup,BushHitGroup";
    enum MaterialId {
        Floor = 0,
        ReflectiveCube = 1,
        Trunk = 2,
        Leaves = 3,
        Bush = 4
    }
    // ObjectConstantBuffer (float4 albedo, uint materialID) as local root constants: 5 dwords.
    const OBJECT_CONSTANTS = 5;
    // 1.0f's bits, the albedo of every record.
    const ONE_BITS = 1065353216;

    // The global root signature's parameters and the descriptors of its tables: the output's UAV;
    // the cube's, trunk's, leaves' and bush's index (raw) and vertex (structured) buffers, then the
    // trunk and bush textures (t1 to t10).
    const OUTPUT_VIEW_SLOT = 0;
    const ACCELERATION_STRUCTURE_SLOT = 1;
    const SCENE_CONSTANT_SLOT = 2;
    const VERTEX_BUFFERS_SLOT = 3;
    const OUTPUT_DESCRIPTOR = 0;
    const FIRST_BUFFER_DESCRIPTOR = 1;
    const TRUNK_TEXTURE_DESCRIPTOR = 9;
    const BUSH_TEXTURE_DESCRIPTOR = 10;
    const DESCRIPTOR_COUNT = 11;

    // RaytracingHlslCompat.h's Vertex: position, normal, uv (float3s).
    const VERTEX_FLOATS = 9;
    const VERTEX_STRIDE = 36;
    // The OBJ models' scale (BuildTreeGeometry).
    const MODEL_SCALE = 0.007;

    // SceneConstantBuffer: projectionToWorld, cameraPosition, lightPosition, lightAmbientColor,
    // lightDiffuseColor (32 floats), then the uint sortMode; constant buffers are 256-byte multiples.
    const SCENE_FLOATS = 32;
    const SORT_MODE_OFFSET = 128;
    const CB_SIZE = 256;

    // SortMode.
    enum SortMode {
        Off = 0,
        ByHit = 1,
        ByMaterial = 2,
        ByBoth = 3
    }

    // D3D12_RAYTRACING_INSTANCE_FLAG_TRIANGLE_CULL_DISABLE.
    const INSTANCE_TRIANGLE_CULL_DISABLE = 1;
    const INSTANCE_COUNT = 13525;

    // Test mode: the frames rendered, each 1/60 s.
    const TEST_FRAMES = 60;

    // BuildCubeGeometry: 24 vertices (position, normal; uv 0), a face's four with its normal, and
    // 36 indices.
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
        3, 1, 0, 2, 1, 3,
        6, 4, 5, 7, 4, 6,
        11, 9, 8, 10, 9, 11,
        14, 12, 13, 15, 12, 14,
        19, 17, 16, 18, 17, 19,
        22, 20, 21, 23, 20, 22,
    ];

    // A mesh's buffers (shaders read them too) and its BLAS.
    class Mesh {
        indexBuffer: BufferHandle;
        vertexBuffer: BufferHandle;
        blas: TriangleBlas;

        constructor(indexBuffer: BufferHandle, vertexBuffer: BufferHandle, blas: TriangleBlas) {
            this.indexBuffer = indexBuffer;
            this.vertexBuffer = vertexBuffer;
            this.blas = blas;
        }
    }

    // Port of DirectX-Graphics-Samples' D3D12RaytracingSakuraForestSER: a ray traced forest of
    // sakura trees, bushes and floor cubes (13525 instances of four BLASes), under a fractal night
    // sky, with Shader Execution Reordering. The ray generation shader traces its primary ray into
    // a HitObject, reorders the threads (MaybeReorderThread) by the hit, by a reflection hint (dark
    // floor texels and the reflective cubes, found through the hit's local root constants), or by
    // both, then invokes the closest hit shader; P toggles SER, H, M and B pick the sort key. WASD,
    // Q and E move the camera, the arrow keys turn it; the light circles once in 8 s. D3D12 only
    // (shader model 6.9 hit objects); its state object comes from the DXIL library's subobjects
    // (Donut_CreateD3D12LibraryRtPipeline), its shader table holds a hit record per instance.
    class SakuraForestPass {
        private app: App;
        private pipeline: D3D12LibraryRtPipeline;
        private topLevelAS: SceneAccelStructs;
        private topLevelASBuilt: boolean;
        private meshes: Mesh[];
        private trunkTexture: TextureHandle;
        private bushTexture: TextureHandle;
        private sceneConstantBuffer: BufferHandle;
        private output: TextureHandle | null;

        // The camera and the light (XMVECTORs), and the scene constants.
        private eye: number[];
        private at: number[];
        private up: number[];
        private lightPosition: number[];
        private sceneData: f32[];
        private sortModeData: int[];

        // Held keys (W, A, S, D, Q, E, Up, Down, Left, Right): 1 while down.
        private held: number[];

        serEnabled: boolean;
        sortByHit: boolean;
        sortByMaterial: boolean;
        sortByBoth: boolean;

        constructor(app: App) {
            this.app = app;
            this.topLevelASBuilt = false;
            this.meshes = [];
            this.output = null;
            this.eye = [];
            this.at = [];
            this.up = [];
            this.lightPosition = [];
            this.sceneData = [];
            for (let i = 0; i < SCENE_FLOATS; i++) {
                this.sceneData.push(0.0);
            }
            this.sortModeData = [0, 0, 0, 0];
            this.held = [];
            for (let i = 0; i < 10; i++) {
                this.held.push(0);
            }
            this.serEnabled = true;
            this.sortByHit = true;
            this.sortByMaterial = false;
            this.sortByBoth = false;
        }

        init(seed: int, bushSeed: int) {
            // InitializeScene's camera: from (0, 2.2, -2) turned 45 degrees about y, towards
            // (1, 2.5, -6), upright.
            this.eye = [0.0, Math.fround(2.2), -2.0, 1.0];
            this.at = [1.0, Math.fround(2.5), -6.0, 1.0];
            const direction = normalize4(vsub(this.at, this.eye));
            this.up = normalize3(cross3(direction, [1.0, 0.0, 0.0, 0.0]));
            this.eye = transform3(this.eye, matrixRotationY(radians(45.0)));
            this.up = [0.0, 1.0, 0.0, 0.0];
            this.lightPosition = [0.0, Math.fround(15.8), 233.0, 0.0];

            this.sceneConstantBuffer = this.app.createConstantBuffer(CB_SIZE, "SceneConstants");

            const commandList = this.app.createCommandList();
            commandList.open();
            const created = this.createGeometry(commandList);
            if (created) {
                this.topLevelAS = this.app.createTopLevelASWithFlags(INSTANCE_COUNT, AccelStructBuildFlags.PreferFastTrace);
                this.createInstances(seed, bushSeed);
            }
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);
            if (!created || this.topLevelAS.isNull()) {
                return false;
            }

            // CreateRaytracingPipelineStateObject: the library's shaders and subobjects.
            const shaderLibrary = this.app.createShaderLibrary("sakura_forest_ser.hlsl");
            if (!shaderLibrary) {
                return false;
            }
            const pipeline = this.app.createD3D12LibraryRtPipeline(shaderLibrary, LIBRARY_EXPORTS, DESCRIPTOR_COUNT);
            if (pipeline.isNull()) {
                return false;
            }
            this.pipeline = pipeline;
            if (!this.createShaderTable()) {
                return false;
            }

            // The global root signature's arguments.
            for (let i = 0; i < this.meshes.length; i++) {
                this.app.setD3D12LibraryRtDescriptorBufferSRV(pipeline, FIRST_BUFFER_DESCRIPTOR + i * 2, this.meshes[i].indexBuffer, 0);
                this.app.setD3D12LibraryRtDescriptorBufferSRV(pipeline, FIRST_BUFFER_DESCRIPTOR + i * 2 + 1, this.meshes[i].vertexBuffer, VERTEX_STRIDE);
            }
            this.app.setD3D12LibraryRtDescriptorTextureSRV(pipeline, TRUNK_TEXTURE_DESCRIPTOR, this.trunkTexture);
            this.app.setD3D12LibraryRtDescriptorTextureSRV(pipeline, BUSH_TEXTURE_DESCRIPTOR, this.bushTexture);
            pipeline.setRootDescriptorTable(OUTPUT_VIEW_SLOT, OUTPUT_DESCRIPTOR);
            pipeline.setRootAccelStruct(ACCELERATION_STRUCTURE_SLOT, this.topLevelAS.getTopLevelAS());
            pipeline.setRootConstantBuffer(SCENE_CONSTANT_SLOT, this.sceneConstantBuffer);
            pipeline.setRootDescriptorTable(VERTEX_BUFFERS_SLOT, FIRST_BUFFER_DESCRIPTOR);

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }

        setSortMode(mode: SortMode) {
            this.serEnabled = mode != SortMode.Off;
            this.sortByHit = mode == SortMode.ByHit;
            this.sortByMaterial = mode == SortMode.ByMaterial;
            this.sortByBoth = mode == SortMode.ByBoth;
        }

        heldIndex(key: Key) {
            const keys = [Key.W, Key.A, Key.S, Key.D, Key.Q, Key.E, Key.Up, Key.Down, Key.Left, Key.Right];
            return keys.indexOf(key);
        }

        isHeld(key: Key) {
            const index = this.heldIndex(key);
            return index >= 0 && this.held[index] != 0;
        }

        // OnUpdate's keys: P toggles SER (sorting by the hit when on), H, M and B pick the sort key
        // (turning SER on); the movement keys are held.
        onKey(key: Key, scancode: ScanCode, action: Action, mods: KeyMods) {
            const index = this.heldIndex(key);
            if (index >= 0) {
                if (action == Action.Press) {
                    this.held[index] = 1;
                } else if (action == Action.Release) {
                    this.held[index] = 0;
                }
            }
            if (action != Action.Press) {
                return 0;
            }
            if (key == Key.P) {
                this.setSortMode(this.serEnabled ? SortMode.Off : SortMode.ByHit);
            } else if (key == Key.H) {
                this.setSortMode(SortMode.ByHit);
            } else if (key == Key.M) {
                this.setSortMode(SortMode.ByMaterial);
            } else if (key == Key.B) {
                this.setSortMode(SortMode.ByBoth);
            }
            return 0;
        }

        // The output texture has the back buffers' size.
        onBackBufferResizing() {
            const output = this.output;
            if (output) {
                this.app.releaseResource(output);
                this.output = null;
            }
        }

        // OnUpdate: the camera moves and turns with the held keys (5 units, 30 degrees a second),
        // never below 2.02; the light circles the y axis once in 8 s.
        onAnimate(elapsedSeconds: number) {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
            const elapsedTime = Math.fround(elapsedSeconds);
            const movementSpeed = Math.fround(5.0 * elapsedTime);
            const speed = [movementSpeed, movementSpeed, movementSpeed, movementSpeed];
            if (this.isHeld(Key.W)) {
                const forward = normalize3(vsub(this.at, this.eye));
                this.eye = vadd(this.eye, vmul(forward, speed));
                this.at = vadd(this.at, vmul(forward, speed));
            }
            if (this.isHeld(Key.S)) {
                const backward = normalize3(vsub(this.eye, this.at));
                this.eye = vadd(this.eye, vmul(backward, speed));
                this.at = vadd(this.at, vmul(backward, speed));
            }
            if (this.isHeld(Key.A)) {
                const forward = normalize3(vsub(this.at, this.eye));
                const left = normalize3(cross3(forward, this.up));
                this.eye = vadd(this.eye, vmul(left, speed));
                this.at = vadd(this.at, vmul(left, speed));
            }
            if (this.isHeld(Key.D)) {
                const forward = normalize3(vsub(this.at, this.eye));
                const right = normalize3(cross3(this.up, forward));
                this.eye = vadd(this.eye, vmul(right, speed));
                this.at = vadd(this.at, vmul(right, speed));
            }
            if (this.isHeld(Key.Q)) {
                this.eye = vadd(this.eye, vmul(this.up, speed));
                this.at = vadd(this.at, vmul(this.up, speed));
            }
            if (this.isHeld(Key.E)) {
                this.eye = vsub(this.eye, vmul(this.up, speed));
                this.at = vsub(this.at, vmul(this.up, speed));
            }
            // Looking down and up, left and right.
            const turnSpeed = Math.fround(radians(30.0) * elapsedTime);
            const negativeTurnSpeed = Math.fround(radians(-30.0) * elapsedTime);
            if (this.isHeld(Key.Down)) {
                this.turn(true, turnSpeed);
            }
            if (this.isHeld(Key.Up)) {
                this.turn(true, negativeTurnSpeed);
            }
            if (this.isHeld(Key.Left)) {
                this.turn(false, negativeTurnSpeed);
            }
            if (this.isHeld(Key.Right)) {
                this.turn(false, turnSpeed);
            }
            const minCameraHeight = Math.fround(2.02);
            const currentHeight = this.eye[1];
            if (currentHeight < minCameraHeight) {
                this.eye[1] = minCameraHeight;
                this.at[1] = Math.fround(this.at[1] + Math.fround(minCameraHeight - currentHeight));
            }

            // Rotate the light around the y axis.
            const angleToRotateBy = Math.fround(-360.0 * Math.fround(elapsedTime / 8.0));
            this.lightPosition = transform3(this.lightPosition, matrixRotationY(radians(angleToRotateBy)));
        }

        // Pitch (about the camera's right vector) or yaw (about up), by angle radians.
        turn(pitch: boolean, angle: number) {
            const forward = normalize3(vsub(this.at, this.eye));
            let axis = this.up;
            if (pitch) {
                axis = normalize3(cross3(this.up, forward));
            }
            const newForward = transformNormal3(forward, matrixRotationAxis(axis, angle));
            this.at = vadd(this.eye, newForward);
        }

        // UpdateCameraMatrices and the rest of the scene constants.
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
            // lightAmbientColor (0.8, 0.8, 0.8, 1), lightDiffuseColor (1.2, 1, 1, 1).
            const colors: number[] = [0.8, 0.8, 0.8, 1.0, 1.2, 1.0, 1.0, 1.0];
            for (let i = 0; i < colors.length; i++) {
                this.sceneData[24 + i] = colors[i];
            }
            let sortMode = SortMode.Off;
            if (!this.serEnabled) {
                sortMode = SortMode.Off;
            } else if (this.sortByHit) {
                sortMode = SortMode.ByHit;
            } else if (this.sortByMaterial) {
                sortMode = SortMode.ByMaterial;
            } else if (this.sortByBoth) {
                sortMode = SortMode.ByBoth;
            }
            this.sortModeData[0] = sortMode;
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const commandList = frame.getCommandList();
            const width = frame.getWidth();
            const height = frame.getHeight();

            let output = this.output;
            if (!output) {
                // CreateRaytracingOutputResource: the back buffer's format and size.
                output = this.app.createUAVTextureForFrameCopy(frame, "RaytracingOutput");
                this.app.setD3D12LibraryRtDescriptorTextureUAV(this.pipeline, OUTPUT_DESCRIPTOR, output);
                this.output = output;
            }

            // The instances don't move: the TLAS is built once.
            if (!this.topLevelASBuilt) {
                frame.buildTopLevelAS(this.topLevelAS);
                this.topLevelASBuilt = true;
            }

            // DoRaytracing: the scene constants, then the rays.
            this.writeSceneConstants(width, height);
            commandList.writeBuffer(this.sceneConstantBuffer, Ref(this.sceneData[0]), SCENE_FLOATS * 4);
            commandList.writeBufferAt(this.sceneConstantBuffer, SORT_MODE_OFFSET, Ref(this.sortModeData[0]), 16);
            commandList.dispatchD3D12LibraryRays(this.pipeline, width, height);

            // CopyRaytracingOutputToBackbuffer.
            frame.copyTextureToFrame(output);
        }

        // A mesh's buffers and BLAS (opaque triangles, preferring fast tracing). indexCount of the
        // indices are the mesh's; any after them are padding the BLAS doesn't use (see
        // createObjMesh).
        createMesh(commandList: CommandList, vertices: f32[], indices: int[], indexCount: int, name: string) {
            const vertexCount = Math.floor(vertices.length / VERTEX_FLOATS);
            const indexBuffer = this.app.createAccelStructInputRawBuffer(indices.length * 4, `${name}IndexBuffer`);
            const vertexBuffer = this.app.createAccelStructInputStructuredBuffer(VERTEX_STRIDE, vertexCount, `${name}VertexBuffer`);
            commandList.writeBuffer(indexBuffer, Ref(indices[0]), indices.length * 4);
            commandList.writeBuffer(vertexBuffer, Ref(vertices[0]), vertices.length * 4);
            const blas = this.app.createEmptyTriangleBlas(`${name}BLAS`);
            blas.addGeometry(indexBuffer, 0, indexCount, vertexBuffer, 0, vertexCount, VERTEX_STRIDE, null);
            if (blas.build(this.app, commandList, AccelStructBuildFlags.PreferFastTrace) == 0) {
                return null;
            }
            return new Mesh(indexBuffer, vertexBuffer, blas);
        }

        // BuildTreeGeometry: an object of the OBJ models, scaled. Its index buffer holds at least
        // minIndexCount indices, zeros after the mesh's: the trunk's closest hit shader reads the
        // leaves' index buffer with the trunk's primitive indices (the sample's IndicesLeaves where
        // IndicesTrunk is meant), past its end for most trunk triangles. Those reads give 0 in the
        // sample (out-of-bounds raw buffer reads do on D3D12), which the zeros reproduce; read past
        // the end here, they hung the GPU.
        createObjMesh(commandList: CommandList, model: ObjModel, objectName: string, name: string, minIndexCount: int) {
            const vertexCount = model.buildMesh(objectName, MODEL_SCALE);
            if (vertexCount <= 0) {
                console.log(`The OBJ models have no object ${objectName}`);
                return null;
            }
            const vertices: f32[] = [];
            for (let i = 0; i < vertexCount * VERTEX_FLOATS; i++) {
                vertices.push(0.0);
            }
            const indices: int[] = [];
            const indexCount = model.getMeshIndexCount();
            for (let i = 0; i < indexCount; i++) {
                indices.push(0);
            }
            model.copyMeshVertices(Ref(vertices[0]));
            model.copyMeshIndices(Ref(indices[0]));
            while (indices.length < minIndexCount) {
                indices.push(0);
            }
            return this.createMesh(commandList, vertices, indices, indexCount, name);
        }

        // BuildCubeGeometry, BuildTreeGeometry and CreateTexture.
        createGeometry(commandList: CommandList) {
            const cubeVertices: f32[] = [];
            for (let i = 0; i < CUBE_VERTICES.length; i += 6) {
                for (let j = 0; j < 6; j++) {
                    cubeVertices.push(CUBE_VERTICES[i + j]);
                }
                cubeVertices.push(0.0);
                cubeVertices.push(0.0);
                cubeVertices.push(0.0);
            }
            const cubeIndices = CUBE_INDICES.map((v): int => v);
            const cube = this.createMesh(commandList, cubeVertices, cubeIndices, cubeIndices.length, "Cube");
            if (!cube) {
                return false;
            }
            this.meshes.push(cube as Mesh);

            // The models: trunk.obj's "tree", leaves.obj's "leaves", bush.obj's "bush".
            const model = ObjModel.create();
            for (const objFile of OBJ_FILES) {
                const file = this.app.loadBinaryFile(MEDIA + objFile);
                if (file.isNull()) {
                    console.log(`Cannot load ${MEDIA}${objFile}: set DIRECTX_GRAPHICS_SAMPLES_DIR when configuring`);
                    model.destroy();
                    return false;
                }
                model.parse(file.getData(), file.getSize());
                this.app.releaseObject(file.handle);
            }
            const objectNames = ["tree", "leaves", "bush"];
            const meshNames = ["Trunk", "Leaves", "Bush"];
            let trunkIndexCount = 0;
            for (let i = 0; i < objectNames.length; i++) {
                // The leaves' index buffer covers the trunk's primitives (see createObjMesh).
                let minIndexCount = 0;
                if (i == 1) {
                    minIndexCount = trunkIndexCount;
                }
                const mesh = this.createObjMesh(commandList, model, objectNames[i], meshNames[i], minIndexCount);
                if (!mesh) {
                    model.destroy();
                    return false;
                }
                this.meshes.push(mesh as Mesh);
                if (i == 0) {
                    trunkIndexCount = model.getMeshIndexCount();
                }
            }
            model.destroy();

            // The textures, as DirectXTK's WIC loader loads them (the trunk's JPEG is sRGB).
            const trunkTexture = this.app.loadWicTexture(commandList, MEDIA + TRUNK_TEXTURE, "TrunkTexture");
            const bushTexture = this.app.loadWicTexture(commandList, MEDIA + BUSH_TEXTURE, "BushTexture");
            if (!trunkTexture || !bushTexture) {
                return false;
            }
            this.trunkTexture = trunkTexture as TextureHandle;
            this.bushTexture = bushTexture as TextureHandle;
            return true;
        }

        // An instance: a uniform scale and a translation, its index as instance ID and hit group.
        addInstance(mesh: Mesh, index: int, scale: number, x: number, y: number, z: number, flags: int) {
            const transform: f32[] = [
                scale, 0.0, 0.0, x,
                0.0, scale, 0.0, y,
                0.0, 0.0, scale, z,
            ];
            this.topLevelAS.addInstanceWithHitGroup(mesh.blas.getAccelStruct(), 1, index, index, flags, Ref(transform[0]));
        }

        // BuildAccelerationStructures' instances: the floor's larger cubes, the small reflective
        // cubes at random heights, the trees (trunks, then leaves at the same places) at random
        // offsets, the bushes at random places. The random offsets come from two std::mt19937s with
        // std::uniform_real_distribution<float>, seeded with seed and bushSeed.
        createInstances(seed: int, bushSeed: int) {
            const cube = this.meshes[0];
            const trunk = this.meshes[1];
            const leaves = this.meshes[2];
            const bush = this.meshes[3];
            const gen = this.app.createRandomEngine(seed);
            const genBush = this.app.createRandomEngine(bushSeed);
            const cubesPerRow = 20;
            const largerCubeSpacing = Math.fround(4.0);
            const randomCubeSpacing = Math.fround(0.1);
            const treesPerRow = 30;
            const treeSpacing = Math.fround(1.9);
            let index = 0;

            // Larger cubes for the floor.
            for (let x = -cubesPerRow / 2; x <= cubesPerRow / 2; x++) {
                for (let z = -cubesPerRow / 2; z <= cubesPerRow / 2; z++) {
                    const posX = Math.fround(Math.fround(x * largerCubeSpacing) + 10.0);
                    const posZ = Math.fround(z * largerCubeSpacing);
                    this.addInstance(cube, index, 2.0, posX, 0.0, posZ, 0);
                    index++;
                }
            }

            // Smaller reflective cubes, placed randomly on the floor.
            const reflectiveCubesPerRow = 30;
            for (let x = -reflectiveCubesPerRow / 2; x <= reflectiveCubesPerRow / 2; x++) {
                for (let z = -reflectiveCubesPerRow / 2; z <= reflectiveCubesPerRow / 2; z++) {
                    const randomYOffset = gen.uniformFloat(-0.1, 0.7);
                    const posX = Math.fround(0.5 + Math.fround(x * randomCubeSpacing));
                    const posY = Math.fround(Math.fround(1.7) + randomYOffset);
                    const posZ = Math.fround(z * randomCubeSpacing);
                    this.addInstance(cube, index, Math.fround(0.01), posX, posY, posZ, 0);
                    index++;
                }
            }

            // Trunks at random offsets, then the leaves at the same places.
            const trunkPositions: number[] = [];
            for (let x = -treesPerRow / 2; x <= treesPerRow / 2; x++) {
                for (let z = -treesPerRow / 2; z <= treesPerRow / 2; z++) {
                    const randomXOffset = gen.uniformFloat(-0.1, 0.7);
                    const randomYOffset = gen.uniformFloat(-0.1, 0.7);
                    const randomZOffset = gen.uniformFloat(-0.1, 0.7);
                    const posX = Math.fround(Math.fround(x * treeSpacing) + Math.fround(randomXOffset / 6.0));
                    const posY = Math.fround(2.0 - Math.fround(randomYOffset / 3.0));
                    const posZ = Math.fround(Math.fround(z * treeSpacing) + Math.fround(randomZOffset / 6.0));
                    trunkPositions.push(posX);
                    trunkPositions.push(posY);
                    trunkPositions.push(posZ);
                    this.addInstance(trunk, index, 35.0, posX, posY, posZ, 0);
                    index++;
                }
            }
            for (let i = 0; i < trunkPositions.length; i += 3) {
                this.addInstance(leaves, index, 35.0, trunkPositions[i], trunkPositions[i + 1], trunkPositions[i + 2], INSTANCE_TRIANGLE_CULL_DISABLE);
                index++;
            }

            // Bushes placed randomly on the floor.
            const bushesPerRow = 100;
            for (let x = -bushesPerRow / 2; x <= bushesPerRow / 2; x++) {
                for (let z = -bushesPerRow / 2; z <= bushesPerRow / 2; z++) {
                    const randomXOffset = gen.uniformFloat(-0.1, 0.7);
                    const randomYOffset = genBush.uniformFloat(0.7, 0.75);
                    const randomZOffset = gen.uniformFloat(-0.1, 0.7);
                    const posX = Math.fround(Math.fround(x * Math.fround(0.2)) + randomXOffset);
                    const posY = Math.fround(Math.fround(1.7) + Math.fround(randomYOffset / 3.0));
                    const posZ = Math.fround(Math.fround(z * Math.fround(0.2)) + randomZOffset);
                    this.addInstance(bush, index, Math.fround(2.1), posX, posY, posZ, 0);
                    index++;
                }
            }
            this.app.releaseObject(gen.handle);
            this.app.releaseObject(genBush.handle);
        }

        // BuildShaderTables: the ray generation record (its local root constants unused), the miss
        // record, and a hit record per instance in instance order: the material's hit group, albedo
        // white, the material ID.
        createShaderTable() {
            const counts: int[] = [441, 961, 961, 961, 10201];
            const materials = [MaterialId.Floor, MaterialId.ReflectiveCube, MaterialId.Trunk, MaterialId.Leaves, MaterialId.Bush];
            const recordHitGroups: int[] = [];
            const recordArgs: int[] = [];
            for (let m = 0; m < counts.length; m++) {
                for (let i = 0; i < counts[m]; i++) {
                    recordHitGroups.push(materials[m]);
                    recordArgs.push(ONE_BITS);
                    recordArgs.push(ONE_BITS);
                    recordArgs.push(ONE_BITS);
                    recordArgs.push(ONE_BITS);
                    recordArgs.push(materials[m]);
                }
            }
            const rayGenArgs: int[] = [0, 0, 0, 0, 0];
            return this.app.setD3D12LibraryRtShaderTableRecords(this.pipeline, "MyRaygenShader", Ref(rayGenArgs[0]), OBJECT_CONSTANTS * 4,
                "MyMissShader", HIT_GROUPS, Ref(recordHitGroups[0]), recordHitGroups.length, Ref(recordArgs[0]), OBJECT_CONSTANTS * 4) != 0;
        }
    }

    // RenderUI: yellow SegoeUI_18 text from (30, 30), the title, then the settings and controls.
    class UserInterface {
        private sample: SakuraForestPass;

        font: ImGuiFont;

        constructor(sample: SakuraForestPass) {
            this.sample = sample;
        }

        init(app: App) {
            const imguiPass = app.addImGuiPass(this.buildUI);
            if (imguiPass.isNull()) {
                return false;
            }
            this.font = imguiPass.createFont(FONT_PATH, FONT_SIZE);
            if (this.font.isNull()) {
                console.log("Cannot load the font: set DONUT_SAMPLES_MEDIA_DIR when configuring");
                return false;
            }
            return true;
        }

        line(y: number, text: string) {
            ImGui.drawText(30.0, y, text, 1.0, 1.0, 0.0, 1.0, 0);
        }

        enabled(on: boolean) {
            if (on) {
                return "Enabled";
            }
            return "Disabled";
        }

        buildUI() {
            const sample = this.sample;
            this.font.push();
            let y = 30.0;
            this.line(y, "D3D12: Shader Execution Reordering");
            y += LINE_SPACING * 2.0;
            this.line(y, `Toggle SER: ${this.enabled(sample.serEnabled)} - Press 'P'`);
            y += LINE_SPACING;
            this.line(y, `Sort by HitObject: ${this.enabled(sample.sortByHit)} - Press 'H'`);
            y += LINE_SPACING;
            this.line(y, `Sort by reflectHint: ${this.enabled(sample.sortByMaterial)} - Press 'M'`);
            y += LINE_SPACING;
            this.line(y, `Sort by both: ${this.enabled(sample.sortByBoth)} - Press 'B'`);
            y += LINE_SPACING;
            this.line(y, "Use WASD to move around");
            y += LINE_SPACING;
            this.line(y, "Use Arrow keys to look around");
            ImGui.popFont();
        }
    }

    // -test: checks the last frame: the forest covers most of it (the sky shows through the gaps,
    // the floor below); the leaves' sakura pinks and the bushes' greens are there.
    function checkFrame(app: App) {
        const width = app.getWindowWidth();
        const height = app.getWindowHeight();
        const pixels: int[] = [];
        for (let i = 0; i < width * height; i++) {
            pixels.push(0);
        }
        if (app.readBackBufferRGBA8(Ref(pixels[0]), pixels.length) == 0) {
            return "cannot read the back buffer";
        }
        let lit = 0;
        let pink = 0;
        let green = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r + g + b > 30) {
                lit++;
            }
            if (r > 150 && r > g + 30 && b > g) {
                pink++;
            }
            if (g > r + 10 && g > b + 10) {
                green++;
            }
        }
        const total = width * height;
        console.log(`Lit ${lit / total}, pink ${pink / total}, green ${green / total}`);
        if (lit < total / 2) {
            return `only ${lit / total} of the frame is lit`;
        }
        if (pink < total / 1000) {
            return "no sakura petals in the frame";
        }
        if (green < total / 1000) {
            return "no bushes in the frame";
        }
        return "";
    }

    class SakuraForestSERArgs extends Args {
        // -seed <n> <n>: the two random engines' seeds (by default from std::random_device, as the
        // sample's: a different forest every run). Negative: seeded from std::random_device, as the
        // sample's.
        seed = -1;
        bushSeed = -1;
        // -sortMode <0..3>: off, by hit, by reflection hint, by both (the sample starts by hit).
        sortMode: int = SortMode.ByHit;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-seed" && i + 2 < this.argc) {
                    this.seed = parseInt(this[i + 1]);
                    this.bushSeed = parseInt(this[i + 2]);
                    i += 2;
                } else if (arg == "-sortMode" && i + 1 < this.argc) {
                    this.sortMode = parseInt(this[i + 1]);
                    i++;
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("sakura_forest_ser");

        // -test [-testOutput <file>]: render 60 frames (at 60 a second) without a window and check
        // the last one (see checkFrame).
        const args = new SakuraForestSERArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        // The sample's window. Hit objects are shader model 6.9's: D3D12 only.
        if (args.api != GraphicsAPI.D3D12) {
            console.log("The Sakura Forest SER example can only run on D3D12 API.");
            return 1;
        }
        // UNORM back buffers, as the sample's R8G8B8A8_UNORM.
        const options = AppOptions.RayTracing | AppOptions.UnormBackBuffer | args.options;
        const app = App.createWithOptions(args.api, WINDOW_TITLE, WIDTH, HEIGHT, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        if (!app.isFeatureSupported(Feature.RayTracingPipeline)) {
            app.destroy();
            return unsupported(args.test, "ERROR: DirectX Raytracing is not supported by your OS, GPU and/or driver.");
        }
        // D3D_SHADER_MODEL_6_9.
        if (app.getD3D12ShaderModel() < 0x69) {
            app.destroy();
            return unsupported(args.test, "ERROR: Device doesn't support Shader Model 6.9.");
        }

        const pass = new SakuraForestPass(app);
        pass.setSortMode(args.sortMode);
        if (!pass.init(args.seed, args.bushSeed)) {
            app.destroy();
            return 1;
        }

        const gui = new UserInterface(pass);
        if (!args.noUI && !gui.init(app)) {
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
    return SakuraForestSER.main(argc, argv);
}

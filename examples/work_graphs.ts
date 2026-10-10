// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace WorkGraphs {
    const WINDOW_TITLE = "Donut Example: Work Graphs";
    const WORK_GRAPH_NAME = "D3D12WorkGraphs";

    // Constants used by deferred shading; they must match the shaders (c_MaxLightsPerTile in
    // shaders/work_graphs_lighting.hlsli, numthreads of the tile shaders).
    const DEFERRED_SHADING_MAX_LIGHTS_PER_TILE = 64;
    const DEFERRED_SHADING_TILE_WIDTH = 8;
    const DEFERRED_SHADING_TILE_HEIGHT = 4;

    // Simulation and camera control constants.
    const CAMERA_POSITION_ORBIT_SPEED = 0.1;
    const CAMERA_TARGET_ORBIT_SPEED = 0.03;
    const CAMERA_POSITION_RADIUS_RATIO = 0.75;
    const CAMERA_TARGET_RADIUS_RATIO = 0.1;
    const CAMERA_CLIMB_SPEED = 0.1;
    const CAMERA_CLIMB_RATIO = 0.6;
    // In radians; (dm::PI_f / 4.0f) * 1.15f, in float32.
    const CAMERA_VERTICAL_FOV = Math.fround(Math.fround(Math.fround(Math.PI) / 4.0) * Math.fround(1.15));
    const CAMERA_NEAR_CLIP_DISTANCE = 0.5;

    // Frames of GPU timer queries in flight.
    const QUEUED_FRAMES_COUNT = 10;

    // Threads per group of the animation compute shaders, and D3D12's limit on groups per dimension.
    const ANIMATION_THREADS_X = 32;
    const D3D12_CS_DISPATCH_MAX_THREAD_GROUPS_PER_DIMENSION = 65535;

    // The techniques of the UI's combo box.
    const TECHNIQUE_WORK_GRAPH_BROADCASTING_LAUNCH = 0;
    const TECHNIQUE_DISPATCH = 1;

    // --- Scene parameters (the list at the top of the sample's scene.cpp) ----------------------

    // Scene size and population (control scene dimensions, number of objects, lights and materials).
    const SCENE_MATERIAL_COUNT_OF_EACH_TYPE = 10;
    const SCENE_FLOORS = 3;
    const SCENE_FLOOR_TO_CEILING_HEIGHT = 70.0;
    const SCENE_FLOOR_SIZE = 500.0; // Larger means more objects and lights.
    const SCENE_OBJECT_ROOM_SIZE = 50.0;
    const SCENE_BALL_ROOM_SIZE = 120.0;
    const SCENE_BALL_SIZE = 15.0;
    const SCENE_LIGHTS_PER_BALL = 3; // Shaders can handle a max number of lights per tile. That must be adjusted according to this value too.

    // Mesh density (control vertex processing cost).
    const SCENE_BOX_SUBDIVISIONS = 100;
    const SCENE_SPHERE_SIDES = 100;
    const SCENE_SPHERE_SLICES = 50;

    // Materials visual look.
    const SCENE_GROUND_COLOR = 0.5;
    const SCENE_PHONG_SPECULAR_COLOR_SCALE = 0.05;
    const SCENE_PHONG_SPECULAR_POWER_MIN = 15.0;
    const SCENE_PHONG_SPECULAR_POWER_RANGE = 25.0;
    const SCENE_VELVET_ROUGHNESS_MIN = 0.45;
    const SCENE_VELVET_ROUGHNESS_RANGE = 0.1;
    const SCENE_FLAKES_SPECULAR_COLOR_SCALE = 0.05;
    const SCENE_FLAKES_SPECULAR_POWER_MIN = 15.0;
    const SCENE_FLAKES_SPECULAR_POWER_RANGE = 25.0;
    const SCENE_FLAKES_GRANULARITY_MIN = 0.3;
    const SCENE_FLAKES_GRANULARITY_RANGE = 0.1;
    const SCENE_STAN_LINE_THICKNESS_MIN = 0.2;
    const SCENE_STAN_LINE_THICKNESS_RANGE = 0.4;
    const SCENE_STAN_LINE_SPACING_MIN = 1.0;
    const SCENE_STAN_LINE_SPACING_RANGE = 3.0;
    const SCENE_CHECKERS_SIZE = 4.0;
    const SCENE_CHECKERS_SPECULAR_POWER_MIN = 15.0;
    const SCENE_CHECKERS_SPECULAR_POWER_RANGE = 25.0;

    // enum AnimType, MeshType and MaterialType (as in shaders/work_graphs_scene_data.hlsli).
    const ANIM_STATIC = 0;
    const ANIM_ROTATE_Y = 1;
    const ANIM_DANCE = 2;

    const MESH_PLANE = 0;
    const MESH_BOX = 1;
    const MESH_SPHERE = 2;
    const MESH_COUNT = 3;

    const MATERIAL_LAMBERT = 0;
    const MATERIAL_PHONG = 1;
    const MATERIAL_METALLIC = 2;
    const MATERIAL_VELVET = 3;
    const MATERIAL_FLAKES = 4;
    const MATERIAL_FACETED = 5;
    const MATERIAL_STAN = 6;
    const MATERIAL_CHECKER = 7;

    // The shaders' structures, as f32 counts; the int fields are written with Donut_StoreInt32.
    // struct Material (36 bytes): baseColor, materialType (uint), param1 (float3), param2, param3.
    const MATERIAL_FLOATS = 9;
    // struct Instance (40 bytes): position, rotationY, size, meshType, material, animType (uints).
    const INSTANCE_FLOATS = 10;
    // struct Light (56 bytes): position, target, targetOffset, color, innerAngle, outerAngle.
    const LIGHT_FLOATS = 14;
    // struct AnimState (40 bytes), written by the GPU only.
    const ANIM_STATE_FLOATS = 10;
    // cbuffer SceneConstantBuffer: viewProj, viewProjInverse, camPosAndSceneTime, camDir,
    // viewportSizeXY, padded to 256 bytes.
    const SCENE_CONSTANTS_FLOATS = 64;
    const SCENE_CONSTANTS_CAM_POS_AND_TIME = 32;
    const SCENE_CONSTANTS_CAM_DIR = 36;
    const SCENE_CONSTANTS_VIEWPORT_SIZE = 40;

    // The shaders' root constants (cbuffer InlineConstants / InstanceConstantBuffer at b0): 3 uints.
    const PUSH_CONSTANTS_SIZE = 12;

    // Bytes per interleaved vertex: float3 position, float3 normal.
    const VERTEX_STRIDE = 24;

    // --- Math ---------------------------------------------------------------------------------

    // srand(0) / rand() of the MSVC runtime the sample is built with, so that the scene comes out the
    // same. (tslang's Math.random isn't usable, and a function named rand clashes with the CRT's.)
    const RAND_MAX = 32767.0;
    let g_RandomSeed = 0.0;
    function msvcRand(): int {
        g_RandomSeed = (g_RandomSeed * 214013.0 + 2531011.0) % 4294967296.0;
        const value: int = Math.floor(g_RandomSeed / 65536.0) % 32768;
        return value;
    }

    class Float3 {
        public x: number;
        public y: number;
        public z: number;

        constructor(x: number, y: number, z: number) {
            this.x = x;
            this.y = y;
            this.z = z;
        }

        normalized(): Float3 {
            const length = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
            return new Float3(this.x / length, this.y / length, this.z / length);
        }
    }

    function randomPosXZ(extentsX: number, y: number, extentsZ: number): Float3 {
        const x = ((msvcRand() / RAND_MAX) - 0.5) * extentsX * 2.0;
        const z = ((msvcRand() / RAND_MAX) - 0.5) * extentsZ * 2.0;
        return new Float3(x, y, z);
    }

    function randomSize(height: number, size: number, heightVariation: number, sizeVariation: number): Float3 {
        const x = size + (msvcRand() / RAND_MAX - 0.5) * sizeVariation;
        const y = height + (msvcRand() / RAND_MAX - 0.5) * heightVariation;
        const z = size + (msvcRand() / RAND_MAX - 0.5) * sizeVariation;
        return new Float3(x, y, z);
    }

    function randomColor(normalized: boolean): Float3 {
        const r = msvcRand() / RAND_MAX;
        const g = msvcRand() / RAND_MAX;
        const b = msvcRand() / RAND_MAX;
        const color = new Float3(r, g, b);
        return normalized ? color.normalized() : color;
    }

    function random01(): number {
        return msvcRand() / RAND_MAX;
    }

    function randomAngle(): number {
        return (msvcRand() / RAND_MAX) * Math.PI * 2.0;
    }

    // 4x4 matrices: 16 numbers, row-major, with Donut's row-vector convention (v * M).

    // The sample's lookToD3DStyle: left-handed view matrix looking from eye at focus.
    function lookToD3DStyle(eye: Float3, focus: Float3, up: Float3): number[] {
        const z = new Float3(focus.x - eye.x, focus.y - eye.y, focus.z - eye.z).normalized();
        // cross(up, z)
        const x = new Float3(up.y * z.z - up.z * z.y, up.z * z.x - up.x * z.z, up.x * z.y - up.y * z.x).normalized();
        // cross(z, x)
        const y = new Float3(z.y * x.z - z.z * x.y, z.z * x.x - z.x * x.z, z.x * x.y - z.y * x.x);

        return [
            x.x, y.x, z.x, 0.0,
            x.y, y.y, z.y, 0.0,
            x.z, y.z, z.z, 0.0,
            -(x.x * eye.x + x.y * eye.y + x.z * eye.z),
            -(y.x * eye.x + y.y * eye.y + y.z * eye.z),
            -(z.x * eye.x + z.y * eye.y + z.z * eye.z),
            1.0,
        ];
    }

    // math::perspProjD3DStyle(verticalFOV, aspect, zNear, zFar).
    // In float32 as Donut's (computed in double, the terms differ in the last bit, which moves
    // edges by a pixel here and there).
    function perspProjD3DStyle(verticalFOV: number, aspect: number, zNear: number, zFar: number): number[] {
        const near = Math.fround(zNear);
        const far = Math.fround(zFar);
        const yScale = Math.fround(1.0 / Math.fround(Math.tan(Math.fround(0.5 * Math.fround(verticalFOV)))));
        const xScale = Math.fround(yScale / Math.fround(aspect));
        const zScale = Math.fround(1.0 / Math.fround(far - near));
        return [
            xScale, 0.0,    0.0,                                         0.0,
            0.0,    yScale, 0.0,                                         0.0,
            0.0,    0.0,    Math.fround(far * zScale),                   1.0,
            0.0,    0.0,    Math.fround(Math.fround(-near * far) * zScale), 0.0,
        ];
    }

    function multiplyMatrices(a: number[], b: number[]): number[] {
        let result: number[] = [];
        for (let row = 0; row < 4; row++) {
            for (let column = 0; column < 4; column++) {
                let sum = 0.0;
                for (let k = 0; k < 4; k++) {
                    sum += a[row * 4 + k] * b[k * 4 + column];
                }
                result.push(sum);
            }
        }
        return result;
    }

    // Gauss-Jordan elimination with partial pivoting; m must be invertible.
    function invertMatrix(m: number[]): number[] {
        let a: number[] = [];
        let inverse: number[] = [];
        for (let i = 0; i < 16; i++) {
            a.push(m[i]);
            inverse.push(i % 5 == 0 ? 1.0 : 0.0);
        }

        for (let column = 0; column < 4; column++) {
            let pivot = column;
            for (let row = column + 1; row < 4; row++) {
                if (Math.abs(a[row * 4 + column]) > Math.abs(a[pivot * 4 + column])) {
                    pivot = row;
                }
            }
            if (pivot != column) {
                for (let k = 0; k < 4; k++) {
                    const t = a[column * 4 + k];
                    a[column * 4 + k] = a[pivot * 4 + k];
                    a[pivot * 4 + k] = t;
                    const u = inverse[column * 4 + k];
                    inverse[column * 4 + k] = inverse[pivot * 4 + k];
                    inverse[pivot * 4 + k] = u;
                }
            }

            const scale = 1.0 / a[column * 4 + column];
            for (let k = 0; k < 4; k++) {
                a[column * 4 + k] *= scale;
                inverse[column * 4 + k] *= scale;
            }

            for (let row = 0; row < 4; row++) {
                if (row == column) {
                    continue;
                }
                const factor = a[row * 4 + column];
                for (let k = 0; k < 4; k++) {
                    a[row * 4 + k] -= factor * a[column * 4 + k];
                    inverse[row * 4 + k] -= factor * inverse[column * 4 + k];
                }
            }
        }
        return inverse;
    }

    // --- Scene (port of the sample's scene.cpp) ------------------------------------------------

    // All math and coordinate systems are left-handed.
    class MeshData {
        // Interleaved position and normal per vertex.
        public vertices: f32[];
        public indices: u16[];
        public vertexCount: int;

        constructor() {
            this.vertices = [];
            this.indices = [];
            this.vertexCount = 0;
        }

        addVertex(px: number, py: number, pz: number, nx: number, ny: number, nz: number): void {
            this.vertices.push(px);
            this.vertices.push(py);
            this.vertices.push(pz);
            this.vertices.push(nx);
            this.vertices.push(ny);
            this.vertices.push(nz);
            this.vertexCount++;
        }

        addIndex(index: int): void {
            this.indices.push(index);
        }
    }

    function generatePlaneInternal(y: number, sign: number, mesh: MeshData): void {
        const baseVertex = mesh.vertexCount;
        mesh.addVertex(-0.5 * sign, y, -0.5, 0.0, sign, 0.0);
        mesh.addVertex(-0.5 * sign, y, 0.5, 0.0, sign, 0.0);
        mesh.addVertex(0.5 * sign, y, 0.5, 0.0, sign, 0.0);
        mesh.addVertex(0.5 * sign, y, -0.5, 0.0, sign, 0.0);

        mesh.addIndex(baseVertex + 0);
        mesh.addIndex(baseVertex + 1);
        mesh.addIndex(baseVertex + 2);
        mesh.addIndex(baseVertex + 2);
        mesh.addIndex(baseVertex + 3);
        mesh.addIndex(baseVertex + 0);
    }

    function generatePlane(mesh: MeshData): void {
        generatePlaneInternal(0.0, 1.0, mesh);
        generatePlaneInternal(0.0, -1.0, mesh);
    }

    // One side of a box: a grid of (subdivisions + 1)^2 vertices over the coordinates coord0 and
    // coord1 (0 = x, 1 = y, 2 = z) of posInit.
    function generateBoxSide(subdivisions: int, coord0: int, coord1: int, posInit: Float3, normal: Float3, sign: number,
        mesh: MeshData): void {
        const baseVertex = mesh.vertexCount;
        let pos: number[] = [posInit.x, posInit.y, posInit.z];
        for (let y = 0; y < subdivisions + 1; y++) {
            pos[coord1] = y / subdivisions - 0.5;
            for (let x = 0; x < subdivisions + 1; x++) {
                pos[coord0] = (x / subdivisions - 0.5) * sign;
                mesh.addVertex(pos[0], pos[1], pos[2], normal.x, normal.y, normal.z);
            }
        }

        for (let y = 0; y < subdivisions; y++) {
            for (let x = 0; x < subdivisions; x++) {
                const faceBaseVertex: int = baseVertex + y * (subdivisions + 1) + x;
                mesh.addIndex(faceBaseVertex + 0);
                mesh.addIndex(faceBaseVertex + (subdivisions + 1) + 0);
                mesh.addIndex(faceBaseVertex + (subdivisions + 1) + 1);

                mesh.addIndex(faceBaseVertex + (subdivisions + 1) + 1);
                mesh.addIndex(faceBaseVertex + 1);
                mesh.addIndex(faceBaseVertex + 0);
            }
        }
    }

    function generateBox(subdivisions: int, mesh: MeshData): void {
        generateBoxSide(subdivisions, 0, 1, new Float3(0.0, 0.0, -0.5), new Float3(0.0, 0.0, -1.0), 1.0, mesh); // Front side.
        generateBoxSide(subdivisions, 2, 1, new Float3(0.5, 0.0, 0.0), new Float3(1.0, 0.0, 0.0), 1.0, mesh);   // Right side.
        generateBoxSide(subdivisions, 0, 1, new Float3(0.0, 0.0, 0.5), new Float3(0.0, 0.0, 1.0), -1.0, mesh);  // Back side.
        generateBoxSide(subdivisions, 2, 1, new Float3(-0.5, 0.0, 0.0), new Float3(-1.0, 0.0, 0.0), -1.0, mesh); // Left side.
        generatePlaneInternal(0.5, 1.0, mesh);   // Top side.
        generatePlaneInternal(-0.5, -1.0, mesh); // Bottom side.
    }

    function generateSphere(sides: int, slices: int, mesh: MeshData): void {
        const baseVertex = mesh.vertexCount;

        mesh.addVertex(0.0, -0.5, 0.0, 0.0, -1.0, 0.0); // Bottom vertex.
        for (let y = 1; y < slices; y++) { // Trunk vertices.
            const posY = y / slices - 0.5;
            const ringRadius = Math.sqrt(1.0 - posY * posY * 4.0) * 0.5;
            for (let x = 0; x < sides; x++) {
                const angle = (x / sides) * Math.PI * 2.0;
                const pos = new Float3(Math.cos(angle) * ringRadius, posY, Math.sin(angle) * ringRadius);
                const normal = pos.normalized();
                mesh.addVertex(pos.x, pos.y, pos.z, normal.x, normal.y, normal.z);
            }
        }
        const capVertex = mesh.vertexCount;
        mesh.addVertex(0.0, 0.5, 0.0, 0.0, 1.0, 0.0); // Top vertex.

        // Bottom cap.
        for (let i = 0; i < sides; i++) {
            mesh.addIndex(baseVertex + 0);
            mesh.addIndex(baseVertex + 1 + i);
            mesh.addIndex(baseVertex + 1 + (i + 1) % sides);
        }

        // Trunk.
        for (let y = 0; y < slices - 2; y++) {
            const sliceBaseVertex: int = baseVertex + 1 + y * sides;
            for (let x = 0; x < sides; x++) {
                mesh.addIndex(sliceBaseVertex + x + 0);
                mesh.addIndex(sliceBaseVertex + x + 0 + sides);
                mesh.addIndex(sliceBaseVertex + (x + 1) % sides + sides);

                mesh.addIndex(sliceBaseVertex + (x + 1) % sides + sides);
                mesh.addIndex(sliceBaseVertex + (x + 1) % sides);
                mesh.addIndex(sliceBaseVertex + x + 0);
            }
        }

        // Top cap.
        const capBaseVertex: int = baseVertex + 1 + (slices - 2) * sides;
        for (let i = 0; i < sides; i++) {
            mesh.addIndex(capBaseVertex + i);
            mesh.addIndex(capVertex);
            mesh.addIndex(capBaseVertex + (i + 1) % sides);
        }
    }

    // Rooms along each side of a floor, for rooms of roomSize.
    function roomCount1D(roomSize: number): int {
        const count: int = Math.floor(SCENE_FLOOR_SIZE / roomSize);
        return count;
    }

    class Material {
        public baseColor: Float3;
        public materialType: int;
        // The type's parameters (the union in the sample's Scene::Material).
        public param1: Float3;
        public param2: number;
        public param3: number;

        constructor(baseColor: Float3, materialType: int) {
            this.baseColor = baseColor;
            this.materialType = materialType;
            this.param1 = new Float3(0.0, 0.0, 0.0);
            this.param2 = 0.0;
            this.param3 = 0.0;
        }
    }

    class Instance {
        public position: Float3;
        public rotationY: number;
        public size: Float3;
        public meshType: int;
        public material: int;
        public animType: int;

        constructor(position: Float3, rotationY: number, size: Float3, meshType: int, material: int, animType: int) {
            this.position = position;
            this.rotationY = rotationY;
            this.size = size;
            this.meshType = meshType;
            this.material = material;
            this.animType = animType;
        }
    }

    class Light {
        public position: Float3;
        public target: Float3;
        public color: Float3;
        public innerAngle: number;
        public outerAngle: number;

        constructor(position: Float3, target: Float3, color: Float3, innerAngle: number, outerAngle: number) {
            this.position = position;
            this.target = target;
            this.color = color;
            this.innerAngle = innerAngle;
            this.outerAngle = outerAngle;
        }
    }

    // Multiple floors, each with a plane, balls hung from the ceiling casting spot lights, and a crowd
    // of animated boxes, all generated procedurally and deterministically; plus their GPU buffers.
    class Scene {
        public materials: Material[];
        public worldObjects: Instance[];
        public lights: Light[];

        // GPU buffers, by MESH_* type for the meshes.
        public vertexBuffers: Opaque[];
        public indexBuffers: Opaque[];
        public indexCounts: int[];
        public materialsBuffer: Opaque;
        public worldObjectsBuffer: Opaque;
        public lightsBuffer: Opaque;
        public animStateBuffer: Opaque;

        // The contents of the structured buffers, laid out as in the shaders.
        private materialData: f32[];
        private instanceData: f32[];
        private lightData: f32[];

        constructor() {
            this.materials = [];
            this.worldObjects = [];
            this.lights = [];
            this.vertexBuffers = [];
            this.indexBuffers = [];
            this.indexCounts = [];
            this.materialData = [];
            this.instanceData = [];
            this.lightData = [];
        }

        static getSceneSize(): number {
            return SCENE_FLOOR_SIZE;
        }

        static getSceneHeight(): number {
            return SCENE_FLOOR_TO_CEILING_HEIGHT * SCENE_FLOORS;
        }

        // Generates the scene and records its upload into an open command list.
        createAssets(app: App, commandList: CommandList): void {
            // Generate geometry data.
            const meshSet: MeshData[] = [new MeshData(), new MeshData(), new MeshData()];
            generatePlane(meshSet[MESH_PLANE]);
            generateBox(SCENE_BOX_SUBDIVISIONS, meshSet[MESH_BOX]);
            generateSphere(SCENE_SPHERE_SIDES, SCENE_SPHERE_SLICES, meshSet[MESH_SPHERE]);

            this.populateWorld();

            // Create GPU buffers and record upload data commands.
            for (let i = 0; i < MESH_COUNT; i++) {
                const mesh = meshSet[i];
                this.vertexBuffers.push(app.createStaticVertexBuffer(commandList, Ref(mesh.vertices[0]),
                    mesh.vertexCount * VERTEX_STRIDE, "MeshVB"));
                // Index buffer, 16-bit indices.
                this.indexBuffers.push(app.createStaticIndexBuffer(commandList, Ref(mesh.indices[0]),
                    mesh.indices.length * 2, "MeshIB"));
                this.indexCounts.push(mesh.indices.length);
            }

            this.packBuffers();

            this.materialsBuffer = app.createStructuredBuffer(MATERIAL_FLOATS * 4, this.materials.length, "MaterialsData");
            commandList.writeBuffer(this.materialsBuffer, Ref(this.materialData[0]), this.materials.length * MATERIAL_FLOATS * 4);

            this.worldObjectsBuffer = app.createStructuredBuffer(INSTANCE_FLOATS * 4, this.worldObjects.length, "InstancesData");
            commandList.writeBuffer(this.worldObjectsBuffer, Ref(this.instanceData[0]), this.worldObjects.length * INSTANCE_FLOATS * 4);

            // Animated by the GPU, hence writable.
            this.lightsBuffer = app.createRWStructuredBuffer(LIGHT_FLOATS * 4, this.lights.length, "LightsData");
            commandList.writeBuffer(this.lightsBuffer, Ref(this.lightData[0]), this.lights.length * LIGHT_FLOATS * 4);

            // Initialized by the animation shader.
            this.animStateBuffer = app.createRWStructuredBuffer(ANIM_STATE_FLOATS * 4, this.worldObjects.length, "AnimState");
        }

        // Lays out the materials, instances and lights as the shaders' structures (all the elements
        // first: Donut_StoreInt32 writes into the arrays' current storage).
        packBuffers(): void {
            for (let i = 0; i < this.materials.length * MATERIAL_FLOATS; i++) {
                this.materialData.push(0.0);
            }
            for (let i = 0; i < this.materials.length; i++) {
                const material = this.materials[i];
                const m = i * MATERIAL_FLOATS;
                this.materialData[m + 0] = material.baseColor.x;
                this.materialData[m + 1] = material.baseColor.y;
                this.materialData[m + 2] = material.baseColor.z;
                Donut_StoreInt32(Ref(this.materialData[m + 3]), material.materialType);
                this.materialData[m + 4] = material.param1.x;
                this.materialData[m + 5] = material.param1.y;
                this.materialData[m + 6] = material.param1.z;
                this.materialData[m + 7] = material.param2;
                this.materialData[m + 8] = material.param3;
            }

            for (let i = 0; i < this.worldObjects.length * INSTANCE_FLOATS; i++) {
                this.instanceData.push(0.0);
            }
            for (let i = 0; i < this.worldObjects.length; i++) {
                const instance = this.worldObjects[i];
                const o = i * INSTANCE_FLOATS;
                this.instanceData[o + 0] = instance.position.x;
                this.instanceData[o + 1] = instance.position.y;
                this.instanceData[o + 2] = instance.position.z;
                this.instanceData[o + 3] = instance.rotationY;
                this.instanceData[o + 4] = instance.size.x;
                this.instanceData[o + 5] = instance.size.y;
                this.instanceData[o + 6] = instance.size.z;
                Donut_StoreInt32(Ref(this.instanceData[o + 7]), instance.meshType);
                Donut_StoreInt32(Ref(this.instanceData[o + 8]), instance.material);
                Donut_StoreInt32(Ref(this.instanceData[o + 9]), instance.animType);
            }

            for (let i = 0; i < this.lights.length * LIGHT_FLOATS; i++) {
                this.lightData.push(0.0);
            }
            for (let i = 0; i < this.lights.length; i++) {
                const light = this.lights[i];
                const l = i * LIGHT_FLOATS;
                this.lightData[l + 0] = light.position.x;
                this.lightData[l + 1] = light.position.y;
                this.lightData[l + 2] = light.position.z;
                this.lightData[l + 3] = light.target.x;
                this.lightData[l + 4] = light.target.y;
                this.lightData[l + 5] = light.target.z;
                // targetOffset (6-8) starts at 0.
                this.lightData[l + 9] = light.color.x;
                this.lightData[l + 10] = light.color.y;
                this.lightData[l + 11] = light.color.z;
                this.lightData[l + 12] = light.innerAngle;
                this.lightData[l + 13] = light.outerAngle;
            }
        }

        populateWorld(): void {
            g_RandomSeed = 0.0; // srand(0): deterministic world content.

            // Generate materials.
            const groundColor = new Float3(SCENE_GROUND_COLOR, SCENE_GROUND_COLOR, SCENE_GROUND_COLOR);
            this.materials.push(new Material(groundColor, MATERIAL_LAMBERT)); // Material 0 is lambert.
            this.materials.push(new Material(new Float3(1.0, 1.0, 1.0), MATERIAL_FACETED)); // Material 1 is faceted.

            // Lamberts.
            for (let i = 0; i < SCENE_MATERIAL_COUNT_OF_EACH_TYPE; i++) {
                this.materials.push(new Material(randomColor(true), MATERIAL_LAMBERT));
            }

            // Phongs: specular color, specular power.
            for (let i = 0; i < SCENE_MATERIAL_COUNT_OF_EACH_TYPE; i++) {
                const material = new Material(randomColor(true), MATERIAL_PHONG);
                const specularColor = randomColor(true);
                material.param1 = new Float3(specularColor.x * SCENE_PHONG_SPECULAR_COLOR_SCALE,
                    specularColor.y * SCENE_PHONG_SPECULAR_COLOR_SCALE, specularColor.z * SCENE_PHONG_SPECULAR_COLOR_SCALE);
                material.param2 = random01() * SCENE_PHONG_SPECULAR_POWER_RANGE + SCENE_PHONG_SPECULAR_POWER_MIN;
                this.materials.push(material);
            }

            // Metallics.
            for (let i = 0; i < SCENE_MATERIAL_COUNT_OF_EACH_TYPE; i++) {
                this.materials.push(new Material(randomColor(true), MATERIAL_METALLIC));
            }

            // Velvets: roughness.
            for (let i = 0; i < SCENE_MATERIAL_COUNT_OF_EACH_TYPE; i++) {
                const material = new Material(randomColor(true), MATERIAL_VELVET);
                material.param1.x = random01() * SCENE_VELVET_ROUGHNESS_RANGE + SCENE_VELVET_ROUGHNESS_MIN;
                this.materials.push(material);
            }

            // Flakes: specular color, specular power, granularity.
            for (let i = 0; i < SCENE_MATERIAL_COUNT_OF_EACH_TYPE; i++) {
                const material = new Material(randomColor(true), MATERIAL_FLAKES);
                const specularColor = randomColor(true);
                material.param1 = new Float3(specularColor.x * SCENE_FLAKES_SPECULAR_COLOR_SCALE,
                    specularColor.y * SCENE_FLAKES_SPECULAR_COLOR_SCALE, specularColor.z * SCENE_FLAKES_SPECULAR_COLOR_SCALE);
                material.param2 = random01() * SCENE_FLAKES_SPECULAR_POWER_RANGE + SCENE_FLAKES_SPECULAR_POWER_MIN;
                material.param3 = random01() * SCENE_FLAKES_GRANULARITY_RANGE + SCENE_FLAKES_GRANULARITY_MIN;
                this.materials.push(material);
            }

            // Stans: lines color, lines thickness, lines spacing.
            for (let i = 0; i < SCENE_MATERIAL_COUNT_OF_EACH_TYPE; i++) {
                const material = new Material(randomColor(true), MATERIAL_STAN);
                material.param1 = randomColor(false);
                material.param2 = random01() * SCENE_STAN_LINE_THICKNESS_RANGE + SCENE_STAN_LINE_THICKNESS_MIN;
                material.param3 = random01() * SCENE_STAN_LINE_SPACING_RANGE + SCENE_STAN_LINE_SPACING_MIN;
                this.materials.push(material);
            }

            // Checkers: second base color, checker size, specular power.
            for (let i = 0; i < SCENE_MATERIAL_COUNT_OF_EACH_TYPE; i++) {
                const material = new Material(randomColor(true), MATERIAL_CHECKER);
                material.param1 = randomColor(false);
                material.param2 = SCENE_CHECKERS_SIZE;
                material.param3 = random01() * SCENE_CHECKERS_SPECULAR_POWER_RANGE + SCENE_CHECKERS_SPECULAR_POWER_MIN;
                this.materials.push(material);
            }

            // Spawn multiple floors, each floor has a single plane, multiple glitter balls, and many cute dancers.
            for (let floor = 0; floor < SCENE_FLOORS; floor++) {
                const floorHeight = floor * SCENE_FLOOR_TO_CEILING_HEIGHT;
                const ceilingHeight = (floor + 1) * SCENE_FLOOR_TO_CEILING_HEIGHT;

                // Ground.
                this.worldObjects.push(new Instance(new Float3(0.0, floorHeight, 0.0), 0.0,
                    new Float3(SCENE_FLOOR_SIZE, 0.0, SCENE_FLOOR_SIZE), MESH_PLANE, 0, ANIM_STATIC));

                // Multiple balls hung from the ceiling, emitting lights.
                const ballRoomCount1D = roomCount1D(SCENE_BALL_ROOM_SIZE);
                const ballHeight = ceilingHeight - SCENE_BALL_SIZE * 0.5;
                for (let roomX = 0; roomX < ballRoomCount1D; roomX++) {
                    for (let roomZ = 0; roomZ < ballRoomCount1D; roomZ++) {
                        const roomCenterX = -SCENE_FLOOR_SIZE * 0.5 + roomX * SCENE_BALL_ROOM_SIZE + SCENE_BALL_ROOM_SIZE * 0.5;
                        const roomCenterZ = -SCENE_FLOOR_SIZE * 0.5 + roomZ * SCENE_BALL_ROOM_SIZE + SCENE_BALL_ROOM_SIZE * 0.5;
                        const ballPos = randomPosXZ((SCENE_BALL_ROOM_SIZE - SCENE_BALL_SIZE) * 0.3, ballHeight,
                            (SCENE_BALL_ROOM_SIZE - SCENE_BALL_SIZE) * 0.3);
                        ballPos.x += roomCenterX;
                        ballPos.z += roomCenterZ;
                        this.worldObjects.push(new Instance(ballPos, randomAngle(),
                            new Float3(SCENE_BALL_SIZE, SCENE_BALL_SIZE, SCENE_BALL_SIZE), MESH_SPHERE, 1, ANIM_ROTATE_Y));

                        // From each ball, generate a few lights.
                        for (let light = 0; light < SCENE_LIGHTS_PER_BALL; light++) {
                            const dir = randomSize(-1.0, 0.0, 0.8, 2.0).normalized();
                            const length = random01() * SCENE_FLOOR_SIZE * 0.35 + SCENE_FLOOR_TO_CEILING_HEIGHT;
                            const target = new Float3(dir.x * length + ballPos.x, dir.y * length + ballPos.y, dir.z * length + ballPos.z);
                            const angle1 = randomAngle() * 0.25 + 0.25; // Within 90-degree limit.
                            const angle2 = randomAngle() * 0.25 + 0.25; // Within 90-degree limit.
                            const innerAngle = Math.min(angle1, angle2);
                            const outerAngle = Math.max(angle1, angle2) + randomAngle() * 0.1;

                            this.lights.push(new Light(ballPos, target, randomColor(true), innerAngle, outerAngle));
                        }
                    }
                }

                // Many objects on the floor, sub-divide the plane into squares and place one object randomly within that square.
                const objectRoomCount1D = roomCount1D(SCENE_OBJECT_ROOM_SIZE);
                for (let roomX = 0; roomX < objectRoomCount1D; roomX++) {
                    for (let roomZ = 0; roomZ < objectRoomCount1D; roomZ++) {
                        const roomCenterX = -SCENE_FLOOR_SIZE * 0.5 + roomX * SCENE_OBJECT_ROOM_SIZE + SCENE_OBJECT_ROOM_SIZE * 0.5;
                        const roomCenterZ = -SCENE_FLOOR_SIZE * 0.5 + roomZ * SCENE_OBJECT_ROOM_SIZE + SCENE_OBJECT_ROOM_SIZE * 0.5;

                        const size = randomSize(SCENE_FLOOR_TO_CEILING_HEIGHT * 0.35, SCENE_OBJECT_ROOM_SIZE * 0.20,
                            SCENE_FLOOR_TO_CEILING_HEIGHT * 0.1, SCENE_OBJECT_ROOM_SIZE * 0.05);
                        const pos = randomPosXZ((SCENE_OBJECT_ROOM_SIZE - size.x) * 0.5, floorHeight + size.y * 0.5,
                            (SCENE_OBJECT_ROOM_SIZE - size.z) * 0.5);
                        pos.x += roomCenterX;
                        pos.y += 0.01; // Counter z-fighting.
                        pos.z += roomCenterZ;
                        const material: int = msvcRand() % (this.materials.length - 2) + 2; // Skip the first two hard-coded materials.

                        this.worldObjects.push(new Instance(pos, randomAngle(), size, MESH_BOX, material, ANIM_DANCE));
                    }
                }
            }
        }
    }

    // --- Passes -------------------------------------------------------------------------------

    // The UI's state, shared by the passes (the sample's UIData).
    class UIData {
        public currentTechnique: int;
        public paused: boolean;
        public resetAnim: boolean;
        public gpuFrameTime: number;
        public gpuShadingTime: number;

        constructor() {
            this.currentTechnique = TECHNIQUE_WORK_GRAPH_BROADCASTING_LAUNCH;
            this.paused = false;
            this.resetAnim = false;
            this.gpuFrameTime = 0.0;
            this.gpuShadingTime = 0.0;
        }
    }

    function getLightTileCountX(viewportWidth: int): int {
        const count: int = Math.floor((viewportWidth + DEFERRED_SHADING_TILE_WIDTH - 1) / DEFERRED_SHADING_TILE_WIDTH);
        return count;
    }

    function getLightTileCountY(viewportHeight: int): int {
        const count: int = Math.floor((viewportHeight + DEFERRED_SHADING_TILE_HEIGHT - 1) / DEFERRED_SHADING_TILE_HEIGHT);
        return count;
    }

    // Port of Donut-Samples' work_graphs_d3d12.cpp: a GPU-animated procedural scene drawn into a
    // g-buffer (normals and material IDs), then lit either by one D3D12 work graph (a light culling
    // node per screen tile feeding per-material shading nodes, broadcasting launch) or by two compute
    // dispatches (tiled light culling, then an uber shader).
    class WorkGraphsPass {
        private app: App;
        private ui: UIData;
        private scene: Scene;

        private bindingLayout: Opaque;
        private inputLayout: Opaque;
        private gbufferVertexShader: Opaque;
        private gbufferPixelShader: Opaque;
        private workGraphLibrary: Opaque;

        // Pipeline state objects.
        private animateObjectsPSO: Opaque;
        private animateLightsPSO: Opaque;
        private cullLightsPSO: Opaque;
        private shadePSO: Opaque;

        // Resources.
        private constantBuffer: Opaque;
        private nullSRVBuffer: Opaque;
        private nullUAVBuffer: Opaque;
        private nullSRVTexture: Opaque;
        private nullUAVTexture: Opaque;

        // Size-dependent (the sample's RenderTargets and what LoadScenePipelines and
        // LoadWorkGraphPipelines create for them): created on the first frame, dropped on resize.
        private targetsWidth: int;
        private targetsHeight: int;
        private depth: Opaque | null;
        private gbuffer: Opaque | null;
        private ldrBuffer: Opaque | null;
        private gbufferFramebuffer: Opaque | null;
        private gbufferFillPSO: Opaque | null;
        private culledLightsBuffer: Opaque | null;
        private animateObjectsBindings: BindingSet;
        private animateLightsBindings: BindingSet;
        private gbufferFillBindings: BindingSet;
        private lightCullingBindings: BindingSet;
        private deferredShadingBindings: BindingSet;
        private workGraphBindings: BindingSet;
        private workGraph: Opaque | null;

        // State.
        private currentTechnique: int;
        private initWorkGraphBackingMemory: boolean;

        // Timing.
        private frameTimers: Opaque[];
        private shadingTimers: Opaque[];
        private nextTimerToUse: int;
        private timeInSeconds: number;
        private timeDiffThisFrame: number;
        private forceResetAnimation: boolean;

        // Uploaded every frame.
        private constants: f32[];
        // Push constants: the animation's (time, time step, reset flag as a uint) and the other
        // shaders' 3 uints.
        private animationConstants: f32[];
        private rootConstants: int[];

        constructor(app: App, ui: UIData) {
            this.app = app;
            this.ui = ui;
            this.scene = new Scene();

            this.targetsWidth = 0;
            this.targetsHeight = 0;
            this.depth = null;
            this.gbuffer = null;
            this.ldrBuffer = null;
            this.gbufferFramebuffer = null;
            this.gbufferFillPSO = null;
            this.culledLightsBuffer = null;
            this.animateObjectsBindings = new BindingSet(null);
            this.animateLightsBindings = new BindingSet(null);
            this.gbufferFillBindings = new BindingSet(null);
            this.lightCullingBindings = new BindingSet(null);
            this.deferredShadingBindings = new BindingSet(null);
            this.workGraphBindings = new BindingSet(null);
            this.workGraph = null;

            this.currentTechnique = TECHNIQUE_WORK_GRAPH_BROADCASTING_LAUNCH;
            this.initWorkGraphBackingMemory = true;

            this.frameTimers = [];
            this.shadingTimers = [];
            this.nextTimerToUse = 0;
            this.timeInSeconds = 0.0;
            this.timeDiffThisFrame = 0.0;
            this.forceResetAnimation = true;

            this.constants = [];
            for (let i = 0; i < SCENE_CONSTANTS_FLOATS; i++) {
                this.constants.push(0.0);
            }
            this.animationConstants = [0.0, 0.0, 0.0];
            this.rootConstants = [0, 0, 0];
        }

        // The newest GPU time (in ms) of a set of timers that the GPU has finished; -1 if none.
        getLastValidQueryTimer(timers: Opaque[]): number {
            for (let i = this.nextTimerToUse - 1; i >= 0; i--) {
                if (this.app.pollTimerQuery(timers[i]) != 0) {
                    return this.app.getTimerQueryTime(timers[i]) * 1000.0;
                }
            }

            for (let i = QUEUED_FRAMES_COUNT - 1; i > this.nextTimerToUse; i--) {
                if (this.app.pollTimerQuery(timers[i]) != 0) {
                    return this.app.getTimerQueryTime(timers[i]) * 1000.0;
                }
            }
            return -1.0;
        }

        onAnimate(elapsedSeconds: number): void {
            if (!this.ui.paused) {
                this.timeDiffThisFrame = elapsedSeconds;
                this.timeInSeconds += elapsedSeconds;
            } else {
                this.timeDiffThisFrame = 0.0;
            }

            const resetAnim = this.forceResetAnimation || this.ui.resetAnim;
            if (resetAnim) {
                this.timeInSeconds = 0.0;
                this.timeDiffThisFrame = 0.0;
            }

            if (this.currentTechnique != this.ui.currentTechnique) {
                this.currentTechnique = this.ui.currentTechnique;
                this.initWorkGraphBackingMemory = true;
            }

            // Update UI info.
            this.ui.gpuFrameTime = this.getLastValidQueryTimer(this.frameTimers);
            this.ui.gpuShadingTime = this.getLastValidQueryTimer(this.shadingTimers);

            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        releaseResource(resource: Opaque | null): void {
            if (resource) {
                this.app.releaseResource(resource);
            }
        }

        // Drops the size-dependent objects.
        releaseRenderTargets(): void {
            const workGraph = this.workGraph;
            if (workGraph) {
                // The GPU reads the work graph and its backing memory without NVRHI knowing, so they
                // can't go while frames using them are in flight.
                this.app.waitForIdle();
                this.app.releaseObject(workGraph);
                this.workGraph = null;
            }

            this.releaseResource(this.workGraphBindings.handle);
            this.releaseResource(this.deferredShadingBindings.handle);
            this.releaseResource(this.lightCullingBindings.handle);
            this.releaseResource(this.gbufferFillBindings.handle);
            this.releaseResource(this.animateLightsBindings.handle);
            this.releaseResource(this.animateObjectsBindings.handle);
            this.releaseResource(this.culledLightsBuffer);
            this.releaseResource(this.gbufferFillPSO);
            this.releaseResource(this.gbufferFramebuffer);
            this.releaseResource(this.ldrBuffer);
            this.releaseResource(this.gbuffer);
            this.releaseResource(this.depth);
            this.workGraphBindings = new BindingSet(null);
            this.deferredShadingBindings = new BindingSet(null);
            this.lightCullingBindings = new BindingSet(null);
            this.gbufferFillBindings = new BindingSet(null);
            this.animateLightsBindings = new BindingSet(null);
            this.animateObjectsBindings = new BindingSet(null);
            this.culledLightsBuffer = null;
            this.gbufferFillPSO = null;
            this.gbufferFramebuffer = null;
            this.ldrBuffer = null;
            this.gbuffer = null;
            this.depth = null;
            this.targetsWidth = 0;
            this.targetsHeight = 0;
        }

        onBackBufferResizing(): void {
            this.releaseRenderTargets();
        }

        // A binding set of the shared layout: every pass fills all its slots, unused ones with null
        // resources. The resource registers must match with assignments used in the shader files.
        createBindingSet(t0: Opaque, t1: Opaque, t2: Opaque, t3: Opaque, t4: Opaque, u0: Opaque, u1: Opaque): BindingSet {
            const desc = BindingSetDesc.create();
            desc.bindPushConstants(0, PUSH_CONSTANTS_SIZE);
            desc.bindEntireConstantBuffer(1, this.constantBuffer);
            desc.bindStructuredBufferSRV(0, t0);
            desc.bindTextureSRV(1, t1);
            desc.bindTextureSRV(2, t2);
            desc.bindStructuredBufferSRV(3, t3);
            desc.bindStructuredBufferSRV(4, t4);
            desc.bindStructuredBufferUAV(0, u0);
            desc.bindTextureUAV(1, u1);
            return this.app.createBindingSetForLayout(desc, this.bindingLayout);
        }

        // First frame or window resize: the render targets, the g-buffer pipeline, the culled lights
        // buffer, the binding sets, and the work graph (whose entry node's grid covers the screen tiles).
        createRenderTargets(frame: Frame, width: int, height: int): boolean {
            const depth = this.app.createRenderTargetTexture(width, height, Format.D32, "DepthBuffer");
            const gbuffer = this.app.createRenderTargetTexture(width, height, Format.RGBA16_UINT, "GBuffer");
            const ldrBuffer = this.app.createUAVTextureForFrameWithFormat(frame, "LDRBuffer", Format.RGBA8_UNORM);
            const gbufferFramebuffer = this.app.createFramebuffer(gbuffer, depth);
            this.depth = depth;
            this.gbuffer = gbuffer;
            this.ldrBuffer = ldrBuffer;
            this.gbufferFramebuffer = gbufferFramebuffer;
            this.targetsWidth = width;
            this.targetsHeight = height;

            const gbufferFillPSO = this.app.createGraphicsPipelineForFramebuffer(gbufferFramebuffer,
                this.gbufferVertexShader, this.gbufferPixelShader, this.inputLayout, this.bindingLayout);
            if (!gbufferFillPSO) {
                return false;
            }
            this.gbufferFillPSO = gbufferFillPSO;

            const tileCount = getLightTileCountX(width) * getLightTileCountY(height);
            const culledLightsBuffer = this.app.createRWStructuredBuffer(4, tileCount * DEFERRED_SHADING_MAX_LIGHTS_PER_TILE, "CulledLights");
            this.culledLightsBuffer = culledLightsBuffer;

            // Create the resource binding sets for each pass. Donut internally takes care of resource
            // states and transition barriers.
            const scene = this.scene;
            this.animateObjectsBindings = this.createBindingSet(scene.worldObjectsBuffer, this.nullSRVTexture, this.nullSRVTexture,
                this.nullSRVBuffer, this.nullSRVBuffer, scene.animStateBuffer, this.nullUAVTexture);
            this.animateLightsBindings = this.createBindingSet(this.nullSRVBuffer, this.nullSRVTexture, this.nullSRVTexture,
                this.nullSRVBuffer, this.nullSRVBuffer, scene.lightsBuffer, this.nullUAVTexture);
            this.gbufferFillBindings = this.createBindingSet(scene.worldObjectsBuffer, this.nullSRVTexture, this.nullSRVTexture,
                scene.materialsBuffer, scene.animStateBuffer, this.nullUAVBuffer, this.nullUAVTexture);
            this.lightCullingBindings = this.createBindingSet(this.nullSRVBuffer, depth, this.nullSRVTexture,
                this.nullSRVBuffer, scene.lightsBuffer, culledLightsBuffer, this.nullUAVTexture);
            this.deferredShadingBindings = this.createBindingSet(scene.materialsBuffer, gbuffer, depth,
                culledLightsBuffer, scene.lightsBuffer, this.nullUAVBuffer, ldrBuffer);
            this.workGraphBindings = this.createBindingSet(scene.materialsBuffer, gbuffer, depth,
                this.nullSRVBuffer, scene.lightsBuffer, this.nullUAVBuffer, ldrBuffer);

            // The root node's dispatch grid size is hard-coded via a shader attribute, but must follow
            // the window size; overriding it in the state object costs less at launch than making the
            // root node use SV_DispatchGrid in its input record. The graph shares the root signature
            // of the application's other shaders (they all use the one binding layout).
            const workGraph = this.app.createD3D12WorkGraph(this.workGraphLibrary, this.shadePSO, WORK_GRAPH_NAME,
                "LightCull_Node", getLightTileCountX(width), getLightTileCountY(height), 1);
            if (!workGraph) {
                return false;
            }
            this.workGraph = workGraph;
            // New backing memory.
            this.initWorkGraphBackingMemory = true;

            // Animation state must be reset to good values before being updated every frame.
            this.forceResetAnimation = true;
            return true;
        }

        updateSceneConstants(commandList: CommandList): void {
            // Camera calculations.
            const sceneSize = Scene.getSceneSize();
            const sceneHeight = Scene.getSceneHeight();
            const time = this.timeInSeconds;

            const camPosition = new Float3(
                Math.cos(time * CAMERA_POSITION_ORBIT_SPEED) * sceneSize * CAMERA_POSITION_RADIUS_RATIO,
                Math.sin(time * CAMERA_CLIMB_SPEED - 1.75) * sceneHeight * CAMERA_CLIMB_RATIO + sceneHeight * CAMERA_CLIMB_RATIO + 10.0,
                Math.sin(time * CAMERA_POSITION_ORBIT_SPEED) * sceneSize * CAMERA_POSITION_RADIUS_RATIO);
            const camTarget = new Float3(
                Math.cos(time * CAMERA_TARGET_ORBIT_SPEED) * sceneSize * CAMERA_TARGET_RADIUS_RATIO,
                0.0,
                Math.sin(time * CAMERA_TARGET_ORBIT_SPEED) * sceneSize * CAMERA_TARGET_RADIUS_RATIO);

            const aspectRatio = this.targetsWidth / this.targetsHeight;
            const view = lookToD3DStyle(camPosition, camTarget, new Float3(0.0, 1.0, 0.0));
            const proj = perspProjD3DStyle(CAMERA_VERTICAL_FOV, aspectRatio, CAMERA_NEAR_CLIP_DISTANCE,
                Math.fround(Math.fround(sceneSize) * Math.fround(1.2)));
            const viewProj = multiplyMatrices(view, proj);
            const viewProjInverse = invertMatrix(viewProj);

            // Both transposed, as the sample uploads them.
            for (let row = 0; row < 4; row++) {
                for (let column = 0; column < 4; column++) {
                    this.constants[row * 4 + column] = viewProj[column * 4 + row];
                    this.constants[16 + row * 4 + column] = viewProjInverse[column * 4 + row];
                }
            }

            this.constants[SCENE_CONSTANTS_CAM_POS_AND_TIME + 0] = camPosition.x;
            this.constants[SCENE_CONSTANTS_CAM_POS_AND_TIME + 1] = camPosition.y;
            this.constants[SCENE_CONSTANTS_CAM_POS_AND_TIME + 2] = camPosition.z;
            this.constants[SCENE_CONSTANTS_CAM_POS_AND_TIME + 3] = time;
            const camDir = new Float3(camTarget.x - camPosition.x, camTarget.y - camPosition.y, camTarget.z - camPosition.z).normalized();
            this.constants[SCENE_CONSTANTS_CAM_DIR + 0] = camDir.x;
            this.constants[SCENE_CONSTANTS_CAM_DIR + 1] = camDir.y;
            this.constants[SCENE_CONSTANTS_CAM_DIR + 2] = camDir.z;
            this.constants[SCENE_CONSTANTS_CAM_DIR + 3] = 0.0;
            this.constants[SCENE_CONSTANTS_VIEWPORT_SIZE + 0] = this.targetsWidth;
            this.constants[SCENE_CONSTANTS_VIEWPORT_SIZE + 1] = this.targetsHeight;

            // Donut internally handles versioning of the buffer.
            commandList.writeBuffer(this.constantBuffer, Ref(this.constants[0]), SCENE_CONSTANTS_FLOATS * 4);
        }

        // Enough thread groups of the animation shaders for `count` elements, laid out as the sample does.
        dispatchAnimation(commandList: CommandList, pipeline: Opaque, bindingSet: BindingSet, count: int): void {
            const totalDispatchSize: int = Math.floor((count + ANIMATION_THREADS_X - 1) / ANIMATION_THREADS_X);
            const dispatchY: int = Math.max(Math.floor(totalDispatchSize / D3D12_CS_DISPATCH_MAX_THREAD_GROUPS_PER_DIMENSION), 1);
            const dispatchX: int = Math.max(totalDispatchSize % D3D12_CS_DISPATCH_MAX_THREAD_GROUPS_PER_DIMENSION, 1);
            commandList.dispatchWithPushConstants(pipeline, bindingSet, Ref(this.animationConstants[0]),
                PUSH_CONSTANTS_SIZE, dispatchX, dispatchY, 1);
        }

        populateAnimationPass(commandList: CommandList, objectsBindings: BindingSet, lightsBindings: BindingSet): void {
            commandList.beginMarker("Animation");

            const resetAnim = this.forceResetAnimation || this.ui.resetAnim;
            this.animationConstants[0] = this.timeInSeconds;
            this.animationConstants[1] = this.timeDiffThisFrame;
            Donut_StoreInt32(Ref(this.animationConstants[2]), resetAnim ? 1 : 0);

            // Object animation, then light animation.
            this.dispatchAnimation(commandList, this.animateObjectsPSO, objectsBindings, this.scene.worldObjects.length);
            this.dispatchAnimation(commandList, this.animateLightsPSO, lightsBindings, this.scene.lights.length);

            commandList.endMarker();

            this.forceResetAnimation = false; // Animation buffer initialized, no need to redo it again in subsequent frames.
        }

        populateGBufferPass(frame: Frame, commandList: CommandList, depth: Opaque, framebuffer: Opaque, pipeline: Opaque,
            bindingSet: BindingSet): void {
            // It is enough to clear the depth-buffer without the g-buffer. Depth buffer values of 1 mean "sky".
            commandList.clearDepth(depth, 1.0);

            commandList.beginMarker("Draw all meshes");

            const scene = this.scene;
            let lastMeshType = MESH_COUNT;
            let indexCount = 0;
            for (let objectIndex = 0; objectIndex < scene.worldObjects.length; objectIndex++) {
                const meshType = scene.worldObjects[objectIndex].meshType;
                if (meshType != lastMeshType) {
                    lastMeshType = meshType;

                    indexCount = scene.indexCounts[meshType];
                    frame.beginDrawToFramebuffer(pipeline, framebuffer);
                    frame.drawAddBindingSet(bindingSet);
                    frame.drawSetIndexBuffer16(scene.indexBuffers[meshType]);
                    frame.drawAddVertexBuffer(scene.vertexBuffers[meshType], 0, 0);
                }

                this.rootConstants[0] = objectIndex;
                this.rootConstants[1] = 0;
                this.rootConstants[2] = 0;
                frame.drawIndexedWithPushConstants(indexCount, Ref(this.rootConstants[0]), PUSH_CONSTANTS_SIZE);
            }

            commandList.endMarker();
        }

        // Tiled light culling, then deferred shading with an uber shader, as compute dispatches.
        populateDeferredShadingDispatches(commandList: CommandList, lightCullingBindings: BindingSet, deferredShadingBindings: BindingSet): void {
            const tilesX = getLightTileCountX(this.targetsWidth);
            const tilesY = getLightTileCountY(this.targetsHeight);
            this.rootConstants[0] = tilesX;
            this.rootConstants[1] = tilesY;
            this.rootConstants[2] = this.scene.lights.length;

            // Dispatch enough thread groups to cover all screen tiles.
            commandList.beginMarker("Light Culling");
            commandList.dispatchWithPushConstants(this.cullLightsPSO, lightCullingBindings,
                Ref(this.rootConstants[0]), PUSH_CONSTANTS_SIZE, tilesX, tilesY, 1);
            commandList.endMarker();

            // Dispatch enough thread groups to cover the entire viewport.
            const threadsX = 8;
            const threadsY = 4;
            const groupsX: int = Math.floor((this.targetsWidth + threadsX - 1) / threadsX);
            const groupsY: int = Math.floor((this.targetsHeight + threadsY - 1) / threadsY);
            commandList.beginMarker("Deferred Shading");
            commandList.dispatchWithPushConstants(this.shadePSO, deferredShadingBindings,
                Ref(this.rootConstants[0]), PUSH_CONSTANTS_SIZE, groupsX, groupsY, 1);
            commandList.endMarker();
        }

        populateDeferredShadingWorkGraph(commandList: CommandList, workGraph: Opaque, bindingSet: BindingSet): void {
            commandList.beginMarker("Deferred Shading Work Graph");

            this.rootConstants[0] = this.scene.lights.length;
            this.rootConstants[1] = 0;
            this.rootConstants[2] = 0;

            // Initialize the work graph backing memory only when the backing memory was never used
            // before or if it was used by a different work graph.
            commandList.dispatchD3D12WorkGraph(workGraph, this.shadePSO, bindingSet,
                Ref(this.rootConstants[0]), PUSH_CONSTANTS_SIZE, this.initWorkGraphBackingMemory ? 1 : 0);
            this.initWorkGraphBackingMemory = false; // Memory initialized, no need to redo it again in subsequent frames.

            commandList.endMarker();
        }

        onRender(frameHandle: Opaque): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();

            // First frame or window resize. This is where the bulk of the loading occurs.
            if (!this.workGraph || this.targetsWidth != width || this.targetsHeight != height) {
                this.releaseRenderTargets();
                if (!this.createRenderTargets(frame, width, height)) {
                    console.log("Cannot create the render targets, pipelines or work graph");
                    this.app.closeWindow();
                    return;
                }
            }

            const depth = this.depth;
            const ldrBuffer = this.ldrBuffer;
            const gbufferFramebuffer = this.gbufferFramebuffer;
            const gbufferFillPSO = this.gbufferFillPSO;
            const animateObjectsBindings = this.animateObjectsBindings;
            const animateLightsBindings = this.animateLightsBindings;
            const gbufferFillBindings = this.gbufferFillBindings;
            const lightCullingBindings = this.lightCullingBindings;
            const deferredShadingBindings = this.deferredShadingBindings;
            const workGraphBindings = this.workGraphBindings;
            const workGraph = this.workGraph;
            if (!depth || !ldrBuffer || !gbufferFramebuffer || !gbufferFillPSO || !workGraph) {
                return;
            }
            if (animateObjectsBindings.isNull() || animateLightsBindings.isNull() || gbufferFillBindings.isNull()
                || lightCullingBindings.isNull() || deferredShadingBindings.isNull() || workGraphBindings.isNull()) {
                return;
            }

            const commandList = frame.getCommandList();
            const frameTimer = this.frameTimers[this.nextTimerToUse];
            const shadingTimer = this.shadingTimers[this.nextTimerToUse];

            // Reset GPU timers.
            this.app.resetTimerQuery(frameTimer);
            this.app.resetTimerQuery(shadingTimer);

            commandList.beginTimerQuery(frameTimer);

            // Update scene constants used by all the passes to follow in this frame.
            this.updateSceneConstants(commandList);

            // Animation compute passes.
            this.populateAnimationPass(commandList, animateObjectsBindings, animateLightsBindings);

            // G-buffer fill pass.
            this.populateGBufferPass(frame, commandList, depth, gbufferFramebuffer, gbufferFillPSO, gbufferFillBindings);

            commandList.beginTimerQuery(shadingTimer);
            if (this.currentTechnique == TECHNIQUE_DISPATCH) {
                // Light culling and deferred shading passes.
                this.populateDeferredShadingDispatches(commandList, lightCullingBindings, deferredShadingBindings);
            } else {
                // Deferred shading work graph pass.
                this.populateDeferredShadingWorkGraph(commandList, workGraph, workGraphBindings);
            }
            commandList.endTimerQuery(shadingTimer);

            // Copy the final shaded results from the LDR buffer to the back buffer for display.
            frame.copyTextureToFrame(ldrBuffer);

            commandList.endTimerQuery(frameTimer);

            this.nextTimerToUse = (this.nextTimerToUse + 1) % QUEUED_FRAMES_COUNT;
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            // Resources used to fill unused shader binding slots (null resources).
            this.nullSRVBuffer = this.app.createStructuredBuffer(16, 32, "NullSRVBuffer");
            this.nullUAVBuffer = this.app.createRWStructuredBuffer(16, 32, "NullUAVBuffer");
            this.nullSRVTexture = this.app.createUAVTexture(1, 1, "NullSRVTexture");
            this.nullUAVTexture = this.app.createUAVTexture(1, 1, "NullUAVTexture");

            for (let i = 0; i < QUEUED_FRAMES_COUNT; i++) {
                this.frameTimers.push(this.app.createTimerQuery());
                this.shadingTimers.push(this.app.createTimerQuery());
            }

            // Create the scene procedurally.
            const commandList = this.app.createCommandList();
            commandList.open();
            this.scene.createAssets(this.app, commandList);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);

            const animateObjectsShader = this.app.createShader("work_graphs_animation.hlsl", "CSMainObjects", ShaderType.Compute);
            const animateLightsShader = this.app.createShader("work_graphs_animation.hlsl", "CSMainLights", ShaderType.Compute);
            const gbufferVertexShader = this.app.createShader("work_graphs_gbuffer_fill.hlsl", "VSMain", ShaderType.Vertex);
            const gbufferPixelShader = this.app.createShader("work_graphs_gbuffer_fill.hlsl", "PSMain", ShaderType.Pixel);
            const lightCullingShader = this.app.createShader("work_graphs_light_culling.hlsl", "CSMain", ShaderType.Compute);
            const deferredShadingShader = this.app.createShader("work_graphs_deferred_shading.hlsl", "CSMain", ShaderType.Compute);
            // The work graph shader library represents a full work graph, and contains all node shaders for that graph.
            const workGraphLibrary = this.app.createShaderLibrary("work_graphs_broadcasting.hlsl");
            if (!animateObjectsShader || !animateLightsShader || !gbufferVertexShader || !gbufferPixelShader
                || !lightCullingShader || !deferredShadingShader || !workGraphLibrary) {
                console.log("Cannot load the shaders");
                return false;
            }
            this.gbufferVertexShader = gbufferVertexShader;
            this.gbufferPixelShader = gbufferPixelShader;
            this.workGraphLibrary = workGraphLibrary;

            // One binding layout for every shader, the work graph included.
            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutPushConstants(0, PUSH_CONSTANTS_SIZE);
            layoutDesc.layoutVolatileConstantBuffer(1);
            layoutDesc.layoutStructuredBufferSRV(0);
            layoutDesc.layoutTextureSRV(1);
            layoutDesc.layoutTextureSRV(2);
            layoutDesc.layoutStructuredBufferSRV(3);
            layoutDesc.layoutStructuredBufferSRV(4);
            layoutDesc.layoutStructuredBufferUAV(0);
            layoutDesc.layoutTextureUAV(1);
            this.bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.All);

            const inputLayoutDesc = InputLayoutDesc.create();
            inputLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_STRIDE);
            inputLayoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, 12, 0, VERTEX_STRIDE);
            this.inputLayout = this.app.createInputLayout(inputLayoutDesc, gbufferVertexShader);

            this.animateObjectsPSO = this.app.createComputePipelineWithLayout(animateObjectsShader, this.bindingLayout);
            this.animateLightsPSO = this.app.createComputePipelineWithLayout(animateLightsShader, this.bindingLayout);
            this.cullLightsPSO = this.app.createComputePipelineWithLayout(lightCullingShader, this.bindingLayout);
            this.shadePSO = this.app.createComputePipelineWithLayout(deferredShadingShader, this.bindingLayout);

            this.constantBuffer = this.app.createVolatileConstantBuffer(SCENE_CONSTANTS_FLOATS * 4, "SceneConstants");

            const pass = this.app.addPass();
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The options and stats window (the sample's UIRenderer).
    class UserInterface {
        private ui: UIData;

        constructor(ui: UIData) {
            this.ui = ui;
        }

        buildUI(): void {
            const ui = this.ui;

            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("Options/Stats", 1);
            ui.currentTechnique = Donut_ImGuiCombo("Current Technique", ui.currentTechnique,
                "Work Graph (Broadcast Launch)|Compute Dispatches");
            ui.paused = Donut_ImGuiCheckbox("Pause Animation", ui.paused ? 1 : 0) != 0;
            ui.resetAnim = Donut_ImGuiButton("Reset Animation") != 0;
            Donut_ImGuiText(`Frame Time (GPU): ${ui.gpuFrameTime.toFixed(3)} ms`);
            Donut_ImGuiText(`Shading Time (GPU): ${ui.gpuShadingTime.toFixed(3)} ms`);
            Donut_ImGuiEnd();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App): boolean {
            return !app.addImGuiPass(this.buildUI).isNull();
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("work_graphs");

        // -debug: the D3D12 debug layer and NVRHI's validation layer.
        let options = AppOptions.None;
        for (let i = 1; i < argc; i++) {
            if (Donut_GetArg(argv, i) == "-debug") {
                options = AppOptions.DebugRuntime;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        if (api != GraphicsAPI.D3D12) {
            console.log("The Work Graphs example can only run on D3D12 API.");
            return 1;
        }

        const app = App.createWithOptions(api, WINDOW_TITLE, 1920, 1080, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        const workGraphsTier = app.getD3D12WorkGraphsTier();
        if (workGraphsTier == 0) {
            console.log("D3D12 device reports it has no support for work graphs. This sample cannot run.\n"
                + "Please make sure you download the latest graphics driver with support for work graphs, "
                + "and that the hardware does support this feature.");
            app.destroy();
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}, work graphs tier ${workGraphsTier / 10}`);

        const uiData = new UIData();
        const example = new WorkGraphsPass(app, uiData);
        if (!example.init()) {
            app.destroy();
            return 1;
        }

        // Drawn after (over) the scene.
        const gui = new UserInterface(uiData);
        if (!gui.init(app)) {
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
    return WorkGraphs.main(argc, argv);
}

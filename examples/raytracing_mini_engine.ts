// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, unsupported } from "../core/test_check";
import {
    XM_2PI, XM_PI, XM_PIDIV2, cross3, dot3, fromRows, matrixInverse, matrixMultiply, matrixRotationQuaternion,
    matrixRotationX, matrixRotationY, matrixTranspose, normalize3, quaternionConjugate, quaternionRotationMatrix,
    reciprocalSqrt, row, transformNormal3, vector3Rotate, vmul,
} from "../core/directx_math";

namespace RaytracingMiniEngine {
    const WINDOW_TITLE = "D3D12RaytracingMiniEngineSample";
    // The sample's Sponza (MiniEngine's sponza.h3d and its DDS textures), from DIRECTX_GRAPHICS_SAMPLES_DIR.
    const MEDIA = "media/raytracing_mini_engine/";

    // ModelH3D's file: a Header, Mesh[meshCount], Material[materialCount] (with their 16-byte aligned
    // Math::Vector3 / Color members), then the vertices, the indices, and depth-only copies of both.
    const H3D_HEADER_SIZE = 64;
    const H3D_MESH_SIZE = 336;
    const H3D_MATERIAL_SIZE = 992;
    const H3D_PATH_SIZE = 128;
    // ModelH3D's attributes: position, texcoord0, normal, tangent, bitangent (at their offsets in a vertex).
    const ATTRIB_COUNT = 5;

    // sizeof(RayTraceMeshInfo), HitShaderConstants (b0) and DynamicCB (b1), in bytes (constant buffers
    // 256-byte multiples).
    const MESH_INFO_SIZE = 32;
    const HIT_CONSTANTS_SIZE = 256;
    const DYNAMIC_CONSTANTS_SIZE = 256;
    // sizeof(RayPayload) (bool SkipShading, float RayHitT), the attributes, MaxRayRecursion.
    const PAYLOAD_SIZE = 8;
    const ATTRIBUTE_SIZE = 8;
    const MAX_RAY_RECURSION = 2;

    // The sample's modes (keys 1 to 7), RaytracingMode + 1.
    const MODE_OFF = 1;
    const MODE_BARYCENTRICS = 2;
    const MODE_REFLECTION_BARYCENTRICS = 3;
    const MODE_SHADOW_RAYS = 4;
    const MODE_DIFFUSE_SHADOW_MAPS = 5;
    const MODE_DIFFUSE_SHADOW_RAYS = 6;
    const MODE_REFLECTIONS = 7;
    const MODE_NAMES = ["Off", "Bary Rays", "Refl Bary", "Shadow Rays", "Diffuse&ShadowMaps", "Diffuse&ShadowRays",
        "Reflection Rays"];

    // RaytracingTypes: the pipelines, each the sample's state object with its libraries swapped.
    const PIPELINE_PRIMARY_BARYCENTRIC = 0;
    const PIPELINE_REFLECTION_BARYCENTRIC = 1;
    const PIPELINE_SHADOWS = 2;
    const PIPELINE_DIFFUSE = 3;
    const PIPELINE_REFLECTION = 4;
    const PIPELINE_COUNT = 5;

    // Test mode: the frames rendered (the camera and lighting don't move).
    const TEST_FRAMES = 4;

    // The characters a texture path can have, by code from 32 (tslang strings are built from them).
    const PRINTABLE = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";

    // A float from its bits.
    function floatFromBits(bits: int): number {
        const exponent = (bits >> 23) & 255;
        const mantissa = bits & 0x7FFFFF;
        const sign = bits < 0 ? -1.0 : 1.0;
        if (exponent == 0) {
            return sign * mantissa * Math.pow(2.0, -149.0);
        }
        return sign * (1.0 + mantissa / 8388608.0) * Math.pow(2.0, exponent - 127);
    }

    class H3dMesh {
        materialIndex: int = 0;
        vertexStride: int = 0;
        // Byte offsets of the attributes in a vertex (ATTRIB_COUNT).
        attribOffsets: int[] = [];
        vertexDataByteOffset: int = 0;
        vertexCount: int = 0;
        indexDataByteOffset: int = 0;
        indexCount: int = 0;
    }

    class H3dMaterial {
        diffusePath: string = "";
        specularPath: string = "";
        normalPath: string = "";
    }

    // ModelH3D::LoadH3D: the meshes and materials, where the vertex and index data are in the file.
    class H3dModel {
        meshes: H3dMesh[] = [];
        materials: H3dMaterial[] = [];
        vertexDataByteSize: int = 0;
        indexDataByteSize: int = 0;
        // The file offset of the vertex data (the index data follows).
        dataOffset: int = 0;
        boundsMin: number[] = [];
        boundsMax: number[] = [];
        file: BinaryFile = new BinaryFile(null);

        load(app: App, path: string): boolean {
            const file = app.loadBinaryFile(path);
            if (file.isNull()) {
                return false;
            }
            this.file = file;
            const header: int[] = [];
            for (let i = 0; i < H3D_HEADER_SIZE / 4; i++) {
                header.push(0);
            }
            file.copyUInts(0, header.length, Ref(header[0]));
            const meshCount = header[0];
            const materialCount = header[1];
            this.vertexDataByteSize = header[2];
            this.indexDataByteSize = header[3];
            // Header::boundingBox (two Vector3s) at 32.
            this.boundsMin = [floatFromBits(header[8]), floatFromBits(header[9]), floatFromBits(header[10])];
            this.boundsMax = [floatFromBits(header[12]), floatFromBits(header[13]), floatFromBits(header[14])];
            this.dataOffset = H3D_HEADER_SIZE + meshCount * H3D_MESH_SIZE + materialCount * H3D_MATERIAL_SIZE;
            if (file.getSize() < this.dataOffset + this.vertexDataByteSize + this.indexDataByteSize) {
                console.log(`${path} is too short`);
                return false;
            }

            const words: int[] = [];
            for (let i = 0; i < H3D_MESH_SIZE / 4; i++) {
                words.push(0);
            }
            for (let m = 0; m < meshCount; m++) {
                file.copyUInts(H3D_HEADER_SIZE + m * H3D_MESH_SIZE, words.length, Ref(words[0]));
                const mesh = new H3dMesh();
                // Mesh: boundingBox (32 bytes), materialIndex, attribsEnabled(Depth), vertexStride(Depth),
                // attrib[16] (8 bytes: uint16 offset, normalized, components, format), attribDepth[16],
                // vertexDataByteOffset, vertexCount, indexDataByteOffset, indexCount.
                mesh.materialIndex = words[8];
                mesh.vertexStride = words[11];
                for (let a = 0; a < ATTRIB_COUNT; a++) {
                    mesh.attribOffsets.push(words[13 + a * 2] & 0xFFFF);
                }
                mesh.vertexDataByteOffset = words[77];
                mesh.vertexCount = words[78];
                mesh.indexDataByteOffset = words[79];
                mesh.indexCount = words[80];
                this.meshes.push(mesh);
            }

            const bytes: int[] = [];
            for (let i = 0; i < H3D_PATH_SIZE; i++) {
                bytes.push(0);
            }
            for (let m = 0; m < materialCount; m++) {
                const offset = H3D_HEADER_SIZE + meshCount * H3D_MESH_SIZE + m * H3D_MATERIAL_SIZE;
                // Material: 5 Colors, opacity, shininess, specularStrength, then the texture paths
                // (diffuse, specular, emissive, normal, ...), 128 chars each.
                const material = new H3dMaterial();
                material.diffusePath = this.readPath(offset + 92, bytes);
                material.specularPath = this.readPath(offset + 92 + H3D_PATH_SIZE, bytes);
                material.normalPath = this.readPath(offset + 92 + 3 * H3D_PATH_SIZE, bytes);
                this.materials.push(material);
            }
            return true;
        }

        private readPath(offset: int, bytes: int[]): string {
            this.file.copyBytes(offset, H3D_PATH_SIZE, Ref(bytes[0]));
            let path = "";
            for (let i = 0; i < H3D_PATH_SIZE; i++) {
                const c = bytes[i];
                if (c == 0) {
                    break;
                }
                path += c >= 32 && c < 127 ? PRINTABLE.charAt(c - 32) : "_";
            }
            return path;
        }
    }

    // A path without its extension (Utility::RemoveExtension).
    function removeExtension(path: string): string {
        const dot = path.lastIndexOf(".");
        return dot >= 0 ? path.substring(0, dot) : path;
    }

    function zeros(count: int): f32[] {
        const values: f32[] = [];
        for (let i = 0; i < count; i++) {
            values.push(0.0);
        }
        return values;
    }

    // Math::Camera with FlyingFPSCamera's orientation, as MiniEngine computes them (DirectXMath's SSE2
    // math, float after every operation): SetHeadingPitchAndPosition (the orientation from the world's
    // east, up and south by a heading about y then a pitch about x), BaseCamera::SetTransform's
    // SetLookDirection (re-orthonormalized, as a quaternion), Update's view matrix (the inverted
    // rigid transform) and view-projection matrix; Camera's reversed-z projection (z range 1 to
    // 10000, a 45 degree vertical field of view, its default height / width of 9 / 16).
    class MiniEngineCamera {
        heading: number = 0.0;
        pitch: number = 0.0;
        position: number[] = [0.0, 0.0, 0.0, 0.0];
        view: number[] = [];
        proj: number[] = [];
        viewProj: number[] = [];
        // Transpose(Invert(viewProj)): the sample's DynamicCB::cameraToWorld.
        cameraToWorld: number[] = [];

        constructor() {
            // Camera::UpdateProjMatrix: Y = 1 / tanf(fov / 2), X = Y * height / width, reversed z.
            const y = Math.fround(1.0 / Donut_Tanf(Math.fround(Math.fround(XM_PI / 4.0) * 0.5)));
            const x = Math.fround(y * Math.fround(9.0 / 16.0));
            const q1 = Math.fround(1.0 / Math.fround(10000.0 - 1.0));
            const q2 = Math.fround(q1 * 10000.0);
            this.proj = [x, 0.0, 0.0, 0.0, 0.0, y, 0.0, 0.0, 0.0, 0.0, q1, -1.0, 0.0, 0.0, q2, 0.0];
        }

        setHeadingPitchAndPosition(heading: number, pitch: number, position: number[]) {
            let h = Math.fround(heading);
            if (h > XM_PI) {
                h = Math.fround(h - XM_2PI);
            } else if (h <= -XM_PI) {
                h = Math.fround(h + XM_2PI);
            }
            let p = Math.fround(pitch);
            p = XM_PIDIV2 < p ? XM_PIDIV2 : p;
            p = -XM_PIDIV2 > p ? -XM_PIDIV2 : p;
            this.heading = h;
            this.pitch = p;
            this.position = [Math.fround(position[0]), Math.fround(position[1]), Math.fround(position[2]), Math.fround(position[2])];
            this.update();
        }

        private update() {
            // Matrix3(east, up, south) * MakeYRotation(heading) * MakeXRotation(pitch); Matrix3 * Matrix3
            // transforms the right one's rows by the left one.
            const world = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
            const yawed = this.matrix3Multiply(world, matrixRotationY(this.heading));
            const orientation = this.matrix3Multiply(yawed, matrixRotationX(this.pitch));

            // SetLookDirection(-z, y).
            const z = row(orientation, 2);
            let forward = [-z[0], -z[1], -z[2], -z[3]];
            const forwardLengthSq = dot3(forward, forward);
            forward = vmul(forward, reciprocalSqrt([forwardLengthSq, forwardLengthSq, forwardLengthSq, forwardLengthSq]));
            let right = cross3(forward, row(orientation, 1));
            const rightLengthSq = dot3(right, right);
            right = vmul(right, reciprocalSqrt([rightLengthSq, rightLengthSq, rightLengthSq, rightLengthSq]));
            const up = cross3(right, forward);
            const back = [-forward[0], -forward[1], -forward[2], -forward[3]];
            const rotation = quaternionRotationMatrix(fromRows(right, up, back, [0.0, 0.0, 0.0, 0.0]));

            // Matrix4(~cameraToWorld): the conjugate rotation, and the negated position rotated by it.
            const inverse = quaternionConjugate(rotation);
            const p = this.position;
            const translation = vector3Rotate([-p[0], -p[1], -p[2], -p[3]], inverse);
            const r = matrixRotationQuaternion(inverse);
            this.view = [
                r[0], r[1], r[2], 0.0,
                r[4], r[5], r[6], 0.0,
                r[8], r[9], r[10], 0.0,
                translation[0], translation[1], translation[2], 1.0,
            ];
            // m_ProjMatrix * m_ViewMatrix is XMMatrixMultiply(view, proj).
            this.viewProj = matrixMultiply(this.view, this.proj);
            this.cameraToWorld = matrixTranspose(matrixInverse(this.viewProj));
        }

        // Matrix3 * Matrix3: the right one's rows transformed (as normals) by the left one.
        private matrix3Multiply(a: number[], b: number[]): number[] {
            return fromRows(transformNormal3(row(b, 0), a), transformNormal3(row(b, 1), a), transformNormal3(row(b, 2), a),
                [0.0, 0.0, 0.0, 1.0]);
        }
    }

    // The sample's camera positions (left / right arrow keys): position, heading, pitch.
    const CAMERA_POSITIONS: number[][] = [
        [-1100.0, 170.0, -30.0, 1.5707, 0.0], // Lion's head
        [299.0, 208.0, -202.0, -3.1111, 0.5953], // View of columns
        [-1237.61, 80.60, -26.02, -1.5707, 0.268], // Bottom-up view from the floor
        [-977.90, 595.05, -194.97, -2.077, -0.450], // Top-down view from the second floor
        [-1463.0, 600.0, 394.52, -1.236, 0.0], // View of corridors on the second floor
    ];

    class Settings {
        mode: int = MODE_DIFFUSE_SHADOW_MAPS;
        // -camera: a camera position from the start (-1: the sample's default view).
        camera: int = -1;
        // SSAO::Enable.
        ssao: boolean = true;
        // F: the camera frozen.
        frozen: boolean = false;
        // -dumpScene <dir>: the scene color buffer (R11G11B10_FLOAT) written raw after the test.
        dumpScenePath: string = "";
    }

    class RaytracingMiniEngineArgs extends Args {
        settings: Settings = new Settings();

        // -mode 1..7, -camera 0..4, -ssao 0|1, -dumpScene <dir>.
        protected parseOptions() {
            const s = this.settings;
            for (let i = 1; i + 1 < this.argc; i++) {
                const arg = this[i];
                const value = this[i + 1];
                if (arg == "-mode") {
                    const n = parseInt(value);
                    s.mode = n < 1 ? 1 : n > 7 ? 7 : n;
                    i++;
                } else if (arg == "-camera") {
                    const n = parseInt(value);
                    s.camera = n < 0 ? 0 : n > 4 ? 4 : n;
                    i++;
                } else if (arg == "-ssao") {
                    s.ssao = value != "0";
                    i++;
                } else if (arg == "-dumpScene") {
                    s.dumpScenePath = value;
                    i++;
                }
            }
        }
    }

    class RaytracingMiniEnginePass {
        private app: App;
        private settings: Settings;
        private model: H3dModel = new H3dModel();
        private camera: MiniEngineCamera = new MiniEngineCamera();

        // The geometry (ModelH3D's vertex and index data, raw views of both), the mesh table, the
        // materials' textures (bindless: diffuse 2 m, normal map 2 m + 1).
        private vertexBuffer: BufferHandle | null = null;
        private indexBuffer: BufferHandle | null = null;
        private meshInfoBuffer: BufferHandle | null = null;
        private bindlessLayout: BindingLayoutHandle | null = null;
        private textureTable: DescriptorTableHandle | null = null;
        private blases: TriangleBlas[] = [];
        private topLevelAS: SceneAccelStructs = new SceneAccelStructs(null);
        private topLevelASBuilt: boolean = false;

        private rayTracingLayout: BindingLayoutHandle | null = null;
        private shaderTables: ShaderTable[] = [];
        private hitConstantBuffer: BufferHandle | null = null;
        private dynamicConstantBuffer: BufferHandle | null = null;
        private hitConstants: f32[] = zeros(HIT_CONSTANTS_SIZE / 4);
        private dynamicConstants: f32[] = zeros(DYNAMIC_CONSTANTS_SIZE / 4);
        private defaultSampler: SamplerHandle | null = null;
        private shadowSampler: SamplerHandle | null = null;

        // g_SceneColorBuffer (R11G11B10_FLOAT), and the raster passes' buffers the ray tracing reads:
        // depth, normals, the sun's shadow map, SSAO.
        sceneColor: TextureHandle | null = null;
        private sceneDepth: TextureHandle | null = null;
        private sceneNormals: TextureHandle | null = null;
        private shadowMap: TextureHandle | null = null;
        private ssao: TextureHandle | null = null;
        private rayTracingSet: BindingSet = new BindingSet(null);

        constructor(app: App, settings: Settings) {
            this.app = app;
            this.settings = settings;
        }

        init(): boolean {
            if (!this.model.load(this.app, MEDIA + "sponza.h3d")) {
                console.log(`Cannot load ${MEDIA}sponza.h3d (point DIRECTX_GRAPHICS_SAMPLES_DIR at a DirectX-Graphics-Samples checkout)`);
                return false;
            }
            console.log(`Sponza: ${this.model.meshes.length} meshes, ${this.model.materials.length} materials`);

            const bindlessDesc = BindlessLayoutDesc.create(0, 256, ShaderType.All);
            bindlessDesc.addTextures(1);
            this.bindlessLayout = this.app.createBindlessLayout(bindlessDesc);

            const commandList = this.app.createCommandList();
            commandList.open();
            const created = this.createGeometry(commandList) && this.createTextures(commandList)
                && this.createAccelerationStructures(commandList);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);
            if (!created || !this.createRayTracingPipelines()) {
                return false;
            }

            this.hitConstantBuffer = this.app.createConstantBuffer(HIT_CONSTANTS_SIZE, "Hit Constant Buffer");
            this.dynamicConstantBuffer = this.app.createConstantBuffer(DYNAMIC_CONSTANTS_SIZE, "Dynamic Constant Buffer");
            // InitializeRaytracingStateObjects' static samplers: anisotropic (8) and wrapping; the shadow
            // map's comparison sampler.
            this.defaultSampler = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Wrap, 0.0, 0.0, 3.402823466e+38, 8.0);
            this.shadowSampler = this.app.createComparisonSampler();

            const settings = this.settings;
            if (settings.camera >= 0) {
                this.setCameraPosition(settings.camera);
            } else {
                this.setDefaultCamera();
            }

            const pass = this.app.addPass();
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            pass.setKeyboardCallback(this.onKey);
            return true;
        }

        // ModelH3D's geometry buffer, split: the vertices (an attribute view of all of them, the BLASes'
        // positions) and the 16-bit indices (their raw view; a whole number of uints).
        private createGeometry(commandList: CommandList): boolean {
            const model = this.model;
            const vertexBuffer = this.app.createAccelStructInputRawBuffer(model.vertexDataByteSize, "Sponza vertices");
            const indexBuffer = this.app.createAccelStructInputRawBuffer((model.indexDataByteSize + 3) & ~3, "Sponza indices");
            model.file.writeBufferFromBinaryFile(commandList, vertexBuffer, 0, model.dataOffset, model.vertexDataByteSize);
            model.file.writeBufferFromBinaryFile(commandList, indexBuffer, 0, model.dataOffset + model.vertexDataByteSize,
                model.indexDataByteSize);
            this.vertexBuffer = vertexBuffer;
            this.indexBuffer = indexBuffer;

            // InitializeSceneInfo: RayTraceMeshInfo per mesh.
            const info: int[] = [];
            for (const mesh of model.meshes) {
                const vertices = mesh.vertexDataByteOffset;
                info.push(mesh.indexDataByteOffset);
                info.push(vertices + mesh.attribOffsets[1]);
                info.push(vertices + mesh.attribOffsets[2]);
                info.push(vertices + mesh.attribOffsets[3]);
                info.push(vertices + mesh.attribOffsets[4]);
                info.push(vertices + mesh.attribOffsets[0]);
                info.push(mesh.vertexStride);
                info.push(mesh.materialIndex);
            }
            const meshInfoBuffer = this.app.createStructuredBuffer(MESH_INFO_SIZE, model.meshes.length, "RayTraceMeshInfo");
            commandList.writeBuffer(meshInfoBuffer, Ref(info[0]), info.length * 4);
            this.meshInfoBuffer = meshInfoBuffer;
            return true;
        }

        // ModelH3D::LoadTextures: per material its diffuse texture (sRGB; white if missing) and normal
        // map (its own, else <diffuse>_normal.dds, else the flat default), in the bindless table.
        private createTextures(commandList: CommandList): boolean {
            const app = this.app;
            const materials = this.model.materials;
            const table = app.createDescriptorTable(this.bindlessLayout as BindingLayoutHandle, materials.length * 2);
            if (!table) {
                return false;
            }
            this.textureTable = table;
            // MiniEngine's default textures (1 x 1, RGBA8_UNORM): white opaque, the flat normal 0x00FF8080.
            const white = this.createTexel(commandList, 0xFFFFFFFF, "White opaque");
            const flatNormal = this.createTexel(commandList, 0x00FF8080, "Default normal map");
            for (let m = 0; m < materials.length; m++) {
                const material = materials[m];
                const diffuseBase = MEDIA + removeExtension(material.diffusePath);
                let diffuse = material.diffusePath != "" ? app.loadTexture(commandList, diffuseBase + ".dds", 1) : null;
                if (!diffuse) {
                    diffuse = white;
                }
                let normal = material.normalPath != ""
                    ? app.loadTexture(commandList, MEDIA + removeExtension(material.normalPath) + ".dds", 0) : null;
                if (!normal && material.diffusePath != "") {
                    normal = app.loadTexture(commandList, diffuseBase + "_normal.dds", 0);
                }
                if (!normal) {
                    normal = flatNormal;
                }
                app.writeDescriptorTableTexture(table, m * 2, diffuse as TextureHandle);
                app.writeDescriptorTableTexture(table, m * 2 + 1, normal as TextureHandle);
            }
            return true;
        }

        private createTexel(commandList: CommandList, texel: int, name: string): TextureHandle {
            const texture = this.app.createTextureWithLevels(1, 1, 1, Format.RGBA8_UNORM, name);
            const data: int[] = [texel];
            commandList.writeTextureLevel(texture, 0, Ref(data[0]), 4);
            return texture;
        }

        // Startup: a BLAS per mesh (opaque, its positions and 16-bit indices, preferring fast tracing),
        // and a TLAS instance of each (identity transform, mask 1). The sample's instance ID is 0 and
        // its hit group record the mesh's; here the instance ID is the mesh's, for the one hit group.
        private createAccelerationStructures(commandList: CommandList): boolean {
            const model = this.model;
            for (let m = 0; m < model.meshes.length; m++) {
                const mesh = model.meshes[m];
                const blas = this.app.createEmptyTriangleBlas(`BLAS ${m}`);
                blas.addGeometry16(this.indexBuffer as BufferHandle, mesh.indexDataByteOffset, mesh.indexCount,
                    this.vertexBuffer as BufferHandle, mesh.vertexDataByteOffset + mesh.attribOffsets[0], mesh.vertexCount,
                    mesh.vertexStride, null);
                if (blas.build(this.app, commandList, AccelStructBuildFlags.PreferFastTrace) == 0) {
                    return false;
                }
                this.blases.push(blas);
            }
            const topLevelAS = this.app.createTopLevelASWithFlags(model.meshes.length, AccelStructBuildFlags.PreferFastTrace);
            if (topLevelAS.isNull()) {
                return false;
            }
            const transform: f32[] = [
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0,
            ];
            for (let m = 0; m < this.blases.length; m++) {
                topLevelAS.addInstanceWithHitGroup(this.blases[m].getAccelStruct(), 1, m, 0, 0, Ref(transform[0]));
            }
            this.topLevelAS = topLevelAS;
            return true;
        }

        // InitializeRaytracingStateObjects: the global root signature (scene buffers t1-t5, constants
        // b0 and b1, depth and normals t12 and t13, the output u2, the TLAS t0, the static samplers),
        // and its five state objects - the same ray generation, hit and miss exports from different
        // libraries.
        private createRayTracingPipelines(): boolean {
            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutAccelStruct(0);
            layoutDesc.layoutStructuredBufferSRV(1);
            layoutDesc.layoutRawBufferSRV(2);
            layoutDesc.layoutRawBufferSRV(3);
            layoutDesc.layoutTextureSRV(4);
            layoutDesc.layoutTextureSRV(5);
            layoutDesc.layoutTextureSRV(12);
            layoutDesc.layoutTextureSRV(13);
            layoutDesc.layoutConstantBuffer(0);
            layoutDesc.layoutConstantBuffer(1);
            layoutDesc.layoutTextureUAV(2);
            layoutDesc.layoutSampler(0);
            layoutDesc.layoutSampler(1);
            this.rayTracingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.All);

            const rayGen = this.app.createShaderLibrary("raytracing_mini_engine/RayGenerationShaderLib.hlsl");
            const rayGenSsr = this.app.createShaderLibrary("raytracing_mini_engine/RayGenerationShaderSSRLib.hlsl");
            const rayGenShadows = this.app.createShaderLibrary("raytracing_mini_engine/RayGenerationShadowsLib.hlsl");
            const hit = this.app.createShaderLibrary("raytracing_mini_engine/hitShaderLib.hlsl");
            const diffuseHit = this.app.createShaderLibrary("raytracing_mini_engine/DiffuseHitShaderLib.hlsl");
            const miss = this.app.createShaderLibrary("raytracing_mini_engine/missShaderLib.hlsl");
            const missShadows = this.app.createShaderLibrary("raytracing_mini_engine/missShadowsLib.hlsl");
            if (!rayGen || !rayGenSsr || !rayGenShadows || !hit || !diffuseHit || !miss || !missShadows) {
                return false;
            }
            const rayGens = [rayGen, rayGenSsr, rayGenShadows, rayGen, rayGenSsr];
            const hits = [hit, hit, hit, diffuseHit, diffuseHit];
            const misses = [miss, miss, missShadows, miss, miss];
            for (let p = 0; p < PIPELINE_COUNT; p++) {
                const pipelineDesc = RtPipelineDesc.create(PAYLOAD_SIZE, MAX_RAY_RECURSION);
                pipelineDesc.setMaxAttributeSize(ATTRIBUTE_SIZE);
                pipelineDesc.addGlobalBindingLayout(this.rayTracingLayout as BindingLayoutHandle);
                pipelineDesc.addGlobalBindingLayout(this.bindlessLayout as BindingLayoutHandle);
                pipelineDesc.addShader(rayGens[p] as ShaderLibraryHandle, "RayGen", ShaderType.RayGeneration);
                pipelineDesc.addShader(misses[p] as ShaderLibraryHandle, "Miss", ShaderType.Miss);
                pipelineDesc.addHitGroup(hits[p] as ShaderLibraryHandle, "HitGroup", "Hit", "", null);
                const pipeline = this.app.createRayTracingPipelineFromDesc(pipelineDesc);
                if (!pipeline) {
                    return false;
                }
                const table = this.app.createEmptyShaderTable(pipeline);
                // The shader table keeps the pipeline alive.
                this.app.releaseResource(pipeline);
                table.setRayGeneration("RayGen");
                table.addMiss("Miss");
                table.addHitGroup("HitGroup", null);
                this.shaderTables.push(table);
            }
            return true;
        }

        // The sample's starting view (Sponza::Startup): from half the model's radius along x from its
        // center, looking at the origin; FlyingFPSCamera's heading and pitch of that.
        private setDefaultCamera() {
            const min = this.model.boundsMin;
            const max = this.model.boundsMax;
            const dx = max[0] - min[0];
            const dy = max[1] - min[1];
            const dz = max[2] - min[2];
            const radius = Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.5;
            const eye = [(min[0] + max[0]) * 0.5 + radius * 0.5, (min[1] + max[1]) * 0.5, (min[2] + max[2]) * 0.5];
            const length = Math.sqrt(eye[0] * eye[0] + eye[1] * eye[1] + eye[2] * eye[2]);
            const forward = [-eye[0] / length, -eye[1] / length, -eye[2] / length];
            // Heading: ATan2(-dot(forward, east), dot(forward, north)), north = -z.
            this.camera.setHeadingPitchAndPosition(Math.atan2(-forward[0], -forward[2]), Math.asin(forward[1]), eye);
        }

        private cameraPosition: int = 0;

        // -dumpScene: the camera's matrices as the reference dump has them (view, proj, viewProj,
        // cameraToWorld, position).
        cameraMatrices(): f32[] {
            const c = this.camera;
            const values: f32[] = [];
            for (const m of [c.view, c.proj, c.viewProj, c.cameraToWorld, c.position]) {
                for (const v of m) {
                    values.push(v);
                }
            }
            return values;
        }

        // SetCameraToPredefinedPosition.
        private setCameraPosition(index: int) {
            this.cameraPosition = index;
            const p = CAMERA_POSITIONS[index];
            this.camera.setHeadingPitchAndPosition(p[3], p[4], [p[0], p[1], p[2]]);
        }

        onKey(key: Key, scancode: ScanCode, action: Action, mods: KeyMods): int {
            if (action != Action.Press) {
                return 0;
            }
            const settings = this.settings;
            if (key >= Key.Num1 && key <= Key.Num7) {
                settings.mode = key - Key.Num1 + 1;
                return 1;
            } else if (key == Key.F) {
                settings.frozen = !settings.frozen;
                return 1;
            } else if (key == Key.Left) {
                this.setCameraPosition((this.cameraPosition + CAMERA_POSITIONS.length - 1) % CAMERA_POSITIONS.length);
                return 1;
            } else if (key == Key.Right) {
                this.setCameraPosition((this.cameraPosition + 1) % CAMERA_POSITIONS.length);
                return 1;
            }
            return 0;
        }

        onBackBufferResizing() {
            const set = this.rayTracingSet;
            if (!set.isNull()) {
                this.app.releaseResource(set.handle);
                this.rayTracingSet = new BindingSet(null);
            }
            for (const texture of [this.sceneColor, this.sceneDepth, this.sceneNormals, this.ssao]) {
                if (texture) {
                    this.app.releaseResource(texture);
                }
            }
            this.sceneColor = null;
            this.sceneDepth = null;
            this.sceneNormals = null;
            this.ssao = null;
        }

        onAnimate(elapsedSeconds: number) {
            this.app.setInformativeWindowTitle(`${WINDOW_TITLE} - ${MODE_NAMES[this.settings.mode - 1]}`);
        }

        // The buffers at the back buffers' size (MiniEngine's native resolution): the scene color
        // (R11G11B10_FLOAT, what the ray tracing writes), depth (D32, reversed), normals, SSAO; the
        // 2048 x 2048 sun shadow map (D16).
        private createTargets(width: int, height: int) {
            const app = this.app;
            this.sceneColor = app.createRenderTargetUAVTexture(width, height, Format.R11G11B10_FLOAT, "Main Color Buffer");
            this.sceneDepth = app.createDepthTexture(width, height, Format.D32, 0.0, "Scene Depth Buffer");
            this.sceneNormals = app.createRenderTargetTexture(width, height, Format.RGBA16_FLOAT, "Normals Buffer");
            this.ssao = app.createRenderTargetTexture(width, height, Format.R8_UNORM, "SSAO Full Res");
            if (!this.shadowMap) {
                this.shadowMap = app.createDepthTexture(2048, 2048, Format.D16, 0.0, "Shadow Map");
            }
            const desc = BindingSetDesc.create();
            desc.bindAccelStruct(0, this.topLevelAS.getTopLevelAS());
            desc.bindStructuredBufferSRV(1, this.meshInfoBuffer as BufferHandle);
            desc.bindRawBufferSRV(2, this.indexBuffer as BufferHandle);
            desc.bindRawBufferSRV(3, this.vertexBuffer as BufferHandle);
            desc.bindTextureSRV(4, this.shadowMap as TextureHandle);
            desc.bindTextureSRV(5, this.ssao as TextureHandle);
            desc.bindTextureSRV(12, this.sceneDepth as TextureHandle);
            desc.bindTextureSRV(13, this.sceneNormals as TextureHandle);
            desc.bindConstantBuffer(0, this.hitConstantBuffer as BufferHandle, 0, HIT_CONSTANTS_SIZE);
            desc.bindConstantBuffer(1, this.dynamicConstantBuffer as BufferHandle, 0, DYNAMIC_CONSTANTS_SIZE);
            desc.bindTextureUAV(2, this.sceneColor as TextureHandle);
            desc.bindSampler(0, this.defaultSampler as SamplerHandle);
            desc.bindSampler(1, this.shadowSampler as SamplerHandle);
            this.rayTracingSet = app.createBindingSetForLayout(desc, this.rayTracingLayout as BindingLayoutHandle);
        }

        // Sponza::RenderScene's sun: from its orientation (-0.5) and inclination (0.75), normalized.
        private sunDirection(): number[] {
            const costheta = Donut_Cosf(-0.5);
            const sintheta = Donut_Sinf(-0.5);
            const angle = Math.fround(Math.fround(Math.fround(0.75) * Math.fround(3.14159)) * 0.5);
            const cosphi = Donut_Cosf(angle);
            const sinphi = Donut_Sinf(angle);
            return normalize3([Math.fround(costheta * cosphi), sinphi, Math.fround(sintheta * cosphi), 0.0]);
        }

        // HitShaderConstants: the sun, its light (4) and the ambient light (0.1), each through ExpVar's
        // exp2f(log2f(value)), the shadow map's texel size; whether the hit shader adds to a reflected
        // surface, and whether it traces shadow rays.
        private writeHitConstants(commandList: CommandList, isReflection: boolean, useShadowRays: boolean) {
            const c = this.hitConstants;
            for (let i = 0; i < c.length; i++) {
                c[i] = 0.0;
            }
            const sun = this.sunDirection();
            const sunLight = Math.fround(Donut_Exp2f(Donut_Log2f(4.0)));
            const ambient = Math.fround(Donut_Exp2f(Donut_Log2f(Math.fround(0.1))));
            for (let i = 0; i < 3; i++) {
                c[i] = sun[i];
                c[4 + i] = sunLight;
                c[8 + i] = ambient;
            }
            c[12] = Math.fround(1.0 / 2048.0);
            const bits: int[] = [isReflection ? 1 : 0, useShadowRays ? 1 : 0];
            commandList.writeBuffer(this.hitConstantBuffer as BufferHandle, Ref(c[0]), HIT_CONSTANTS_SIZE);
            // IsReflection and UseShadowRays (uints at 128).
            commandList.writeBufferAt(this.hitConstantBuffer as BufferHandle, 128, Ref(bits[0]), 8);
        }

        // DynamicCB: Transpose(Invert(viewProj)), the camera's position, the output's size.
        private writeDynamicConstants(commandList: CommandList, width: int, height: int) {
            const c = this.dynamicConstants;
            const camera = this.camera;
            for (let i = 0; i < 16; i++) {
                c[i] = camera.cameraToWorld[i];
            }
            c[16] = camera.position[0];
            c[17] = camera.position[1];
            c[18] = camera.position[2];
            c[19] = 0.0;
            c[20] = width;
            c[21] = height;
            commandList.writeBuffer(this.dynamicConstantBuffer as BufferHandle, Ref(c[0]), DYNAMIC_CONSTANTS_SIZE);
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const commandList = frame.getCommandList();
            const width = frame.getWidth();
            const height = frame.getHeight();
            if (!this.sceneColor) {
                this.createTargets(width, height);
            }
            if (!this.topLevelASBuilt) {
                frame.buildTopLevelAS(this.topLevelAS);
                this.topLevelASBuilt = true;
            }
            const settings = this.settings;
            const mode = settings.mode;

            // SSAO::Render with SSAO off clears its buffer to 1.
            commandList.clearTextureFloat(this.ssao as TextureHandle, 1.0, 1.0, 1.0, 1.0);

            // Raytrace.
            let pipeline = -1;
            if (mode == MODE_BARYCENTRICS) {
                pipeline = PIPELINE_PRIMARY_BARYCENTRIC;
            } else if (mode == MODE_DIFFUSE_SHADOW_MAPS || mode == MODE_DIFFUSE_SHADOW_RAYS) {
                pipeline = PIPELINE_DIFFUSE;
            }
            if (pipeline >= 0) {
                this.writeDynamicConstants(commandList, width, height);
                if (pipeline == PIPELINE_PRIMARY_BARYCENTRIC) {
                    this.writeHitConstants(commandList, false, false);
                } else {
                    this.writeHitConstants(commandList, false, mode == MODE_DIFFUSE_SHADOW_RAYS);
                }
                frame.dispatchRaysWithDescriptorTable(this.shaderTables[pipeline], this.rayTracingSet,
                    this.textureTable as DescriptorTableHandle, width, height);
            }
            this.app.blitTexture(frame, this.sceneColor as TextureHandle);
        }
    }

    // -test: the scene color buffer is all written (no NaNs) and not black.
    function checkFrame(app: App, settings: Settings) {
        const check = new TestCheck(app);
        const failure = check.frameRead();
        if (failure != "") {
            return failure;
        }
        const w = check.width;
        const h = check.height;
        let lit = 0;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (check.rgb(x, y) != 0) {
                    lit++;
                }
            }
        }
        return check.share(lit, w * h, 5.0, 100.0, "Non-black");
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Program.setAppName("raytracing_mini_engine");

        const args = new RaytracingMiniEngineArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();
        const settings = args.settings;
        if (args.test && settings.camera < 0) {
            settings.camera = 3;
        }
        if (args.test) {
            settings.frozen = true;
        }

        const options = AppOptions.RayTracing | args.options;
        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        if (!app.isFeatureSupported(Feature.RayTracingPipeline)) {
            app.destroy();
            return unsupported(args.test, "The graphics device does not support ray tracing pipelines");
        }
        console.log(`Renderer: ${app.getRendererString()}`);

        const pass = new RaytracingMiniEnginePass(app, settings);
        if (!pass.init()) {
            app.destroy();
            return 1;
        }
        const input = new InputPass(app.handle);

        app.run();
        let result = 0;
        if (args.test) {
            result = app.finishTest(checkFrame(app, settings));
        }
        app.waitForIdle();
        const sceneColor = pass.sceneColor;
        if (settings.dumpScenePath != "" && sceneColor) {
            const w = app.getWindowWidth();
            const h = app.getWindowHeight();
            const pixels: int[] = [];
            for (let i = 0; i < w * h; i++) {
                pixels.push(0);
            }
            const size = app.readTextureLevel(sceneColor, 0, Ref(pixels[0]), pixels.length * 4);
            if (size == 0 || Donut_WriteBinaryFile(`${settings.dumpScenePath}/color.raw`, Ref(pixels[0]), pixels.length * 4) == 0) {
                console.log(`Cannot write ${settings.dumpScenePath}/color.raw`);
                result = 1;
            }
        }
        if (settings.dumpScenePath != "") {
            const matrices = pass.cameraMatrices();
            Donut_WriteBinaryFile(`${settings.dumpScenePath}/matrices.raw`, Ref(matrices[0]), matrices.length * 4);
        }
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return RaytracingMiniEngine.main(argc, argv);
}

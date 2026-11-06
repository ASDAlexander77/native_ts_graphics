// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, unsupported } from "../core/test_check";
import {
    XM_2PI, XM_PI, XM_PIDIV2, cross3, dot3, fromRows, matrixInverse, matrixMultiply, matrixRotationQuaternion,
    matrixRotationX, matrixRotationY, matrixTranspose, normalize3, quaternionConjugate, quaternionRotationMatrix,
    floor4, reciprocal, reciprocalSqrt, row, transformNormal3, vdiv, vector3Rotate, vmul,
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
    // Sponza::RenderObjects' VSConstants (b0: modelToProjection, modelToShadow, viewerPos) and
    // RenderScene's PSConstants (b2 here), constant buffers; the material index (a push constant).
    const VS_CONSTANTS_SIZE = 256;
    const PS_CONSTANTS_SIZE = 256;
    const MATERIAL_CONSTANT_SIZE = 4;
    // MiniEngine's compute shaders' root constants (b0) and constant buffer (b1), constant buffers here.
    const COMPUTE_CONSTANTS_SIZE = 256;
    // g_ShadowBuffer: 2048 x 2048 D16, its scissor a texel in from the edges.
    const SHADOW_MAP_SIZE = 2048;
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

    // Test mode: the frames rendered (the camera and lighting don't move), the reference build's dump
    // frame.
    const TEST_FRAMES = 3;

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

    function splat4(v: number): number[] {
        return [v, v, v, v];
    }

    function negate4(v: number[]): number[] {
        return [-v[0], -v[1], -v[2], -v[3]];
    }

    // BaseCamera::SetLookDirection: the camera-to-world rotation (a quaternion) of the basis made
    // orthonormal from forward and up - right, up, back.
    function lookRotation(forwardIn: number[], upIn: number[]): number[] {
        const forwardLengthSq = dot3(forwardIn, forwardIn);
        const forward = forwardLengthSq < Math.fround(0.000001) ? [0.0, 0.0, -1.0, -1.0]
            : vmul(forwardIn, reciprocalSqrt(splat4(forwardLengthSq)));
        // (A right of zero length, forward along up, can't happen with the sample's cameras.)
        let right = cross3(forward, upIn);
        const rightLengthSq = dot3(right, right);
        right = vmul(right, reciprocalSqrt(splat4(rightLengthSq)));
        const up = cross3(right, forward);
        return quaternionRotationMatrix(fromRows(right, up, negate4(forward), [0.0, 0.0, 0.0, 0.0]));
    }

    // BaseCamera::Update's view matrix, Matrix4(~m_CameraToWorld): the conjugate rotation, and the
    // negated position rotated by it.
    function viewMatrix(rotation: number[], position: number[]): number[] {
        const inverse = quaternionConjugate(rotation);
        const translation = vector3Rotate(negate4(position), inverse);
        const r = matrixRotationQuaternion(inverse);
        return [
            r[0], r[1], r[2], 0.0,
            r[4], r[5], r[6], 0.0,
            r[8], r[9], r[10], 0.0,
            translation[0], translation[1], translation[2], 1.0,
        ];
    }

    // Matrix3 * Matrix3: the right one's rows transformed (as normals) by the left one.
    function matrix3Multiply(a: number[], b: number[]): number[] {
        return fromRows(transformNormal3(row(b, 0), a), transformNormal3(row(b, 1), a), transformNormal3(row(b, 2), a),
            [0.0, 0.0, 0.0, 1.0]);
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
        // A Vector3's w is its z.
        position: number[] = [0.0, 0.0, 0.0, 0.0];
        view: number[] = [];
        proj: number[] = [];
        viewProj: number[] = [];
        // Transpose(Invert(viewProj)): the sample's DynamicCB::cameraToWorld.
        cameraToWorld: number[] = [];
        // BaseCamera::Update's m_ReprojectMatrix: the previous view-projection matrix times the inverse
        // of this one. (MiniEngine's first previous matrix is uninitialized memory; here it's the first
        // matrix itself, which gives the same zero screen-space velocities as the sample's.)
        previousViewProj: number[] = [];
        reprojection: number[] = [];

        constructor() {
            // Camera::UpdateProjMatrix: Y = 1 / tanf(fov / 2), X = Y * height / width, reversed z.
            const y = Math.fround(1.0 / Donut_Tanf(Math.fround(Math.fround(XM_PI / 4.0) * 0.5)));
            const x = Math.fround(y * Math.fround(9.0 / 16.0));
            const q1 = Math.fround(1.0 / Math.fround(10000.0 - 1.0));
            const q2 = Math.fround(q1 * 10000.0);
            this.proj = [x, 0.0, 0.0, 0.0, 0.0, y, 0.0, 0.0, 0.0, 0.0, q1, -1.0, 0.0, 0.0, q2, 0.0];
        }

        // FlyingFPSCamera::Update: the heading turned by -yaw and the pitch by pitch (clamped), then
        // the position moved by (strafe, ascent, -forward) in the new orientation.
        move(yaw: number, pitch: number, forward: number, strafe: number, ascent: number) {
            let p = Math.fround(this.pitch + pitch);
            p = XM_PIDIV2 < p ? XM_PIDIV2 : p;
            p = -XM_PIDIV2 > p ? -XM_PIDIV2 : p;
            const h = Math.fround(this.heading - yaw);
            const world = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
            const orientation = matrix3Multiply(matrix3Multiply(world, matrixRotationY(h > XM_PI ? Math.fround(h - XM_2PI)
                : h <= -XM_PI ? Math.fround(h + XM_2PI) : h)), matrixRotationX(p));
            const offset = transformNormal3([Math.fround(strafe), Math.fround(ascent), Math.fround(-forward), 0.0], orientation);
            const position = this.position;
            this.setHeadingPitchAndPosition(h, p, [Math.fround(offset[0] + position[0]), Math.fround(offset[1] + position[1]),
                Math.fround(offset[2] + position[2])]);
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

            // Matrix3(east, up, south) * MakeYRotation(heading) * MakeXRotation(pitch), then
            // SetLookDirection(-z, y).
            const world = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
            const orientation = matrix3Multiply(matrix3Multiply(world, matrixRotationY(h)), matrixRotationX(p));
            const rotation = lookRotation(negate4(row(orientation, 2)), row(orientation, 1));
            this.view = viewMatrix(rotation, this.position);
            // m_ProjMatrix * m_ViewMatrix is XMMatrixMultiply(view, proj).
            const viewProj = matrixMultiply(this.view, this.proj);
            this.previousViewProj = this.viewProj.length == 16 ? this.viewProj : viewProj;
            this.viewProj = viewProj;
            this.cameraToWorld = matrixTranspose(matrixInverse(viewProj));
            this.reprojection = matrixMultiply(matrixInverse(viewProj), this.previousViewProj);
        }
    }

    // ShadowCamera::UpdateMatrix: looking along the light (up z), its center moved to whole texels of
    // the shadow map (and of its depth precision), an orthographic projection of the bounds; the
    // shadow matrix (to texture space) after. Zero until first updated (a static's members).
    class ShadowCamera {
        viewProj: number[] = [];
        shadowMatrix: number[] = [];

        constructor() {
            for (let i = 0; i < 16; i++) {
                this.viewProj.push(0.0);
                this.shadowMatrix.push(0.0);
            }
        }

        updateMatrix(lightDirection: number[], center: number[], bounds: number[], width: int, height: int, precision: int) {
            const rotation = lookRotation(lightDirection, [0.0, 0.0, 1.0, 1.0]);
            const rcpDimensions = reciprocal(bounds);
            const quantizeScale = vmul([width, height, (1 << precision) - 1, (1 << precision) - 1], rcpDimensions);
            let shadowCenter = vector3Rotate(center, quaternionConjugate(rotation));
            shadowCenter = vdiv(floor4(vmul(shadowCenter, quantizeScale)), quantizeScale);
            shadowCenter = vector3Rotate(shadowCenter, rotation);
            const view = viewMatrix(rotation, shadowCenter);
            const scale = vmul([2.0, 2.0, 1.0, 1.0], rcpDimensions);
            const proj = [scale[0], 0.0, 0.0, 0.0, 0.0, scale[1], 0.0, 0.0, 0.0, 0.0, scale[2], 0.0, 0.0, 0.0, 0.0, 1.0];
            this.viewProj = matrixMultiply(view, proj);
            // Matrix4(AffineTransform(MakeScale(0.5, -0.5, 1), (0.5, 0.5, 0))) * viewProj.
            const toTexture = [0.5, 0.0, 0.0, 0.0, 0.0, -0.5, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.5, 0.5, 0.0, 1.0];
            this.shadowMatrix = matrixMultiply(this.viewProj, toTexture);
        }
    }

    // One of MiniEngine's compute shaders (Core/Shaders) with a binding layout of its registers: SRVs
    // t0.., UAVs u0.., its root constants b0 and constant buffer b1 (constant buffers here),
    // its root signature's static samplers s0 and s1.
    class MiniEngineCompute {
        layout: BindingLayoutHandle;
        pipeline: ComputePipelineHandle;
        srvCount: int;
        uavCount: int;

        constructor(layout: BindingLayoutHandle, pipeline: ComputePipelineHandle, srvCount: int, uavCount: int) {
            this.layout = layout;
            this.pipeline = pipeline;
            this.srvCount = srvCount;
            this.uavCount = uavCount;
        }
    }

    // SSAO::Initialize's SampleThickness: sqrt(1 - x^2 - y^2) at the sample offsets (0.2, 0), (0.4, 0),
    // (0.6, 0), (0.8, 0), (0.2, 0.2), (0.2, 0.4), (0.2, 0.6), (0.2, 0.8), (0.4, 0.4), (0.4, 0.6), (0.4, 0.8),
    // (0.6, 0.6) - the values MSVC's /fp:fast build folds them to (no rounding of the expression gives all
    // twelve), from its SSAO.obj.
    const SSAO_SAMPLE_THICKNESS = [
        0.9797958731651306, 0.9165151119232178, 0.800000011920929, 0.5999999642372131,
        0.9591662883758545, 0.8944271802902222, 0.774596631526947, 0.5656853914260864,
        0.8246211409568787, 0.6928203105926514, 0.4472135603427887, 0.5291501879692078,
    ];

    // A texture's size: MiniEngine's (width + 2^k - 1) / 2^k.
    function divideUp(size: int, shift: int): int {
        return (size + (1 << shift) - 1) >> shift;
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
        // SSAO::Enable (on, as the sample's; off clears its buffer to 1).
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

    // Port of DirectX-Graphics-Samples' D3D12RaytracingMiniEngineSample (MiniEngine's model viewer with
    // DirectX Raytracing) on NVRHI: MiniEngine's Sponza (sponza.h3d, its DDS textures) as a BLAS per
    // mesh in one TLAS, and the sample's seven modes (keys 1 to 7):
    //   1 Off: rasterized (the depth prepass, the sun's shadow map, the color pass).
    //   2 Bary Rays: primary rays showing the hit's barycentrics.
    //   3 Refl Bary: reflection rays from the depth and normals buffers showing barycentrics - which,
    //     as in the sample, only run where the normals' w (never written) isn't 0: the raster image.
    //   4 Shadow Rays: shadow rays from the depth buffer, white where they miss (the sample's known
    //     bug: mostly black).
    //   5 Diffuse&ShadowMaps: primary rays shaded by the diffuse hit shader (its normal map, texture
    //     LOD from ray differentials, the sun, ambient), shadowed by the sun's shadow map.
    //   6 Diffuse&ShadowRays: the same, shadowed by shadow rays.
    //   7 Reflection Rays: reflections over the raster image - again where the normals' w isn't 0.
    // The sample's five state objects (one exported ray generation, hit and miss shader, their
    // libraries swapped) are five pipelines here; its per-mesh local root signature (the material's
    // textures and the mesh's index) the instance ID and a bindless texture table. MiniEngine's
    // camera (FlyingFPSCamera, Camera) and shadow camera are computed as it computes them, to the
    // last bit (core/directx_math.ts; MSVC's /fp:fast sincos and reciprocal estimates for the sun and
    // SSAO's constants: core/msvc_fast_math.cpp). MiniEngine's frame around the ray tracing is ported
    // too: the depth prepass, the sun's shadow map and the color pass (its model shaders, depth
    // clipping on, TAA's half-pixel viewport offset), SSAO (on by default, as the sample's; -ssao 0
    // clears its buffer to 1), and the camera velocities, TAA blend and sharpening MiniEngine runs
    // even with TAA off. Every mode matches the sample's scene buffer bit for bit (D3D12, its five
    // camera positions). Left out: MiniEngine's point lights (the comparison build's were black)
    // and particles. Left / right cycle the sample's camera positions; W, A,
    // S, D, E, Q move (left shift: finely) and the mouse looks while its left button is held, as
    // MiniEngine's FlyingFPSCamera; F freezes the camera.
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

        // Sponza's rasterization (SponzaRenderer.cpp): the depth prepass, the sun's shadow map and the
        // color pass, each opaque materials then (two-sided, alpha-tested) cutouts.
        private materialIsCutout: boolean[] = [];
        private inputLayout: InputLayoutHandle | null = null;
        private depthInputLayout: InputLayoutHandle | null = null;
        private depthVS: ShaderHandle | null = null;
        private depthPS: ShaderHandle | null = null;
        private modelVS: ShaderHandle | null = null;
        private modelPS: ShaderHandle | null = null;
        private rasterLayout: BindingLayoutHandle | null = null;
        private cameraVSConstants: BufferHandle | null = null;
        private shadowVSConstants: BufferHandle | null = null;
        private psConstantBuffer: BufferHandle | null = null;
        private vsConstants: f32[] = zeros(VS_CONSTANTS_SIZE / 4);
        private psConstants: f32[] = zeros(PS_CONSTANTS_SIZE / 4);
        private materialConstant: int[] = [0];
        private sunShadow: ShadowCamera = new ShadowCamera();
        private depthOpaquePipeline: GraphicsPipelineHandle | null = null;
        private depthCutoutPipeline: GraphicsPipelineHandle | null = null;
        private shadowOpaquePipeline: GraphicsPipelineHandle | null = null;
        private shadowCutoutPipeline: GraphicsPipelineHandle | null = null;
        private colorOpaquePipeline: GraphicsPipelineHandle | null = null;
        private colorCutoutPipeline: GraphicsPipelineHandle | null = null;
        private depthFramebuffer: FramebufferHandle | null = null;
        private shadowFramebuffer: FramebufferHandle | null = null;
        private colorFramebuffer: FramebufferHandle | null = null;
        private cameraRasterSet: BindingSet = new BindingSet(null);
        private shadowRasterSet: BindingSet = new BindingSet(null);

        // MiniEngine's SSAO (SSAO.cpp), camera velocity (MotionBlur.cpp) and temporal resolve
        // (TemporalEffects.cpp: the TAA blend and sharpening, which run even with TAA off).
        private linearizeDepth: MiniEngineCompute | null = null;
        private prepareDepth1: MiniEngineCompute | null = null;
        private prepareDepth2: MiniEngineCompute | null = null;
        private aoRender1: MiniEngineCompute | null = null;
        private aoRender2: MiniEngineCompute | null = null;
        private aoBlurUpsampleFinal: MiniEngineCompute | null = null;
        private aoBlurUpsampleBlend: MiniEngineCompute | null = null;
        private cameraVelocity: MiniEngineCompute | null = null;
        private temporalBlend: MiniEngineCompute | null = null;
        private sharpen: MiniEngineCompute | null = null;
        private computeCB0: BufferHandle | null = null;
        private computeCB1: BufferHandle | null = null;
        private computeConstants: f32[] = zeros(COMPUTE_CONSTANTS_SIZE / 4);
        private linearClampSampler: SamplerHandle | null = null;
        private linearBorderSampler: SamplerHandle | null = null;
        private pointBorderSampler: SamplerHandle | null = null;
        // g_LinearDepth[2], g_VelocityBuffer, g_TemporalColor[2]; SSAO's depth pyramid (downsized 1-4,
        // deinterleaved 16-slice atlases 1-4) and occlusion (merged, high quality, smoothed).
        private linearDepth: TextureHandle[] = [];
        private velocity: TextureHandle | null = null;
        private temporalColor: TextureHandle[] = [];
        private depthDownsize: TextureHandle[] = [];
        private depthTiled: TextureHandle[] = [];
        private aoMerged: TextureHandle[] = [];
        private aoHighQuality: TextureHandle[] = [];
        private aoSmooth: TextureHandle[] = [];
        private postTargetsCleared: boolean = false;
        // -dumpScene: the last frame's SSAO constants (each ComputeAO's 28, each BlurAndUpsample's 8).
        ssaoConstants: f32[] = [];
        // TemporalEffects' frame index (mod 2 picks the linear depth and temporal color written).
        private frameIndex: int = 0;

        // g_SceneColorBuffer (R11G11B10_FLOAT), and the raster passes' buffers the ray tracing reads:
        // depth, normals, the sun's shadow map, SSAO.
        sceneColor: TextureHandle | null = null;
        private sceneDepth: TextureHandle | null = null;
        sceneNormals: TextureHandle | null = null;
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
            this.shadowSampler = this.app.createComparisonSamplerWithFunc(ComparisonFunc.GreaterOrEqual);
            if (!this.createRasterization() || !this.createPostProcessing()) {
                return false;
            }

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
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setMousePosCallback(this.onMousePos);
            return true;
        }

        // ModelH3D's geometry buffer, split: the vertices (the vertex buffer, an attribute view of all of
        // them, the BLASes' positions) and the 16-bit indices (the index buffer and their raw view).
        private createGeometry(commandList: CommandList): boolean {
            const model = this.model;
            const vertexBuffer = this.app.createStaticGeometryBufferFromBinaryFile(commandList, model.file, model.dataOffset,
                model.vertexDataByteSize, false, "Sponza vertices");
            const indexBuffer = this.app.createStaticGeometryBufferFromBinaryFile(commandList, model.file,
                model.dataOffset + model.vertexDataByteSize, model.indexDataByteSize, true, "Sponza indices");
            if (!vertexBuffer || !indexBuffer) {
                return false;
            }
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

        // ModelH3D::LoadTextures: per material its diffuse texture (sRGB; white if missing), specular
        // (sRGB: its own, else <diffuse>_specular.dds, else black) and normal map (its own, else
        // <diffuse>_normal.dds, else the flat default), in the bindless table at 3 m, 3 m + 1, 3 m + 2.
        // SponzaRenderer's cutouts: the materials of thorns, plants and chains.
        private createTextures(commandList: CommandList): boolean {
            const app = this.app;
            const materials = this.model.materials;
            const table = app.createDescriptorTable(this.bindlessLayout as BindingLayoutHandle, materials.length * 3);
            if (!table) {
                return false;
            }
            this.textureTable = table;
            // MiniEngine's default textures (1 x 1, RGBA8_UNORM): white opaque, the flat normal 0x00FF8080.
            const white = this.createTexel(commandList, 0xFFFFFFFF, "White opaque");
            const flatNormal = this.createTexel(commandList, 0x00FF8080, "Default normal map");
            const black = this.createTexel(commandList, 0xFF000000, "Black opaque");
            for (let m = 0; m < materials.length; m++) {
                const material = materials[m];
                const diffuseBase = MEDIA + removeExtension(material.diffusePath);
                let diffuse = material.diffusePath != "" ? app.loadTexture(commandList, diffuseBase + ".dds", 1) : null;
                if (!diffuse) {
                    diffuse = white;
                }
                let specular = material.specularPath != ""
                    ? app.loadTexture(commandList, MEDIA + removeExtension(material.specularPath) + ".dds", 1) : null;
                if (!specular && material.diffusePath != "") {
                    specular = app.loadTexture(commandList, diffuseBase + "_specular.dds", 1);
                }
                if (!specular) {
                    specular = black;
                }
                let normal = material.normalPath != ""
                    ? app.loadTexture(commandList, MEDIA + removeExtension(material.normalPath) + ".dds", 0) : null;
                if (!normal && material.diffusePath != "") {
                    normal = app.loadTexture(commandList, diffuseBase + "_normal.dds", 0);
                }
                if (!normal) {
                    normal = flatNormal;
                }
                app.writeDescriptorTableTexture(table, m * 3, diffuse as TextureHandle);
                app.writeDescriptorTableTexture(table, m * 3 + 1, specular as TextureHandle);
                app.writeDescriptorTableTexture(table, m * 3 + 2, normal as TextureHandle);
                const path = material.diffusePath;
                this.materialIsCutout.push(path.indexOf("thorn") >= 0 || path.indexOf("plant") >= 0 || path.indexOf("chain") >= 0);
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

        // Sponza::Startup's pipeline state: MiniEngine's model vertex (position, texcoord, normal,
        // tangent, bitangent), its renderer root signature as a binding layout (the vertex shader's
        // constants b0, the pixel shader's b2, the material's index b1, SSAO t12, the shadow map t13,
        // the default and shadow samplers s10 and s11) with the materials' bindless table.
        private createRasterization(): boolean {
            const app = this.app;
            this.depthVS = app.createShader("raytracing_mini_engine/DepthViewerVS.hlsl", "main", ShaderType.Vertex);
            this.depthPS = app.createShader("raytracing_mini_engine/DepthViewerPS.hlsl", "main", ShaderType.Pixel);
            this.modelVS = app.createShader("raytracing_mini_engine/ModelViewerVS.hlsl", "main", ShaderType.Vertex);
            this.modelPS = app.createShader("raytracing_mini_engine/ModelViewerPS.hlsl", "main", ShaderType.Pixel);
            if (!this.depthVS || !this.depthPS || !this.modelVS || !this.modelPS) {
                return false;
            }
            const stride = this.model.meshes[0].vertexStride;
            const offsets = this.model.meshes[0].attribOffsets;
            const inputLayoutDesc = InputLayoutDesc.create();
            inputLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, offsets[0], 0, stride);
            inputLayoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, offsets[1], 0, stride);
            inputLayoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, offsets[2], 0, stride);
            inputLayoutDesc.addVertexAttribute("TANGENT", Format.RGB32_FLOAT, offsets[3], 0, stride);
            inputLayoutDesc.addVertexAttribute("BITANGENT", Format.RGB32_FLOAT, offsets[4], 0, stride);
            this.inputLayout = app.createInputLayout(inputLayoutDesc, this.modelVS as ShaderHandle);
            // The depth passes' vertex shader reads the position and texcoord only.
            const depthLayoutDesc = InputLayoutDesc.create();
            depthLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, offsets[0], 0, stride);
            depthLayoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, offsets[1], 0, stride);
            this.depthInputLayout = app.createInputLayout(depthLayoutDesc, this.depthVS as ShaderHandle);

            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutConstantBuffer(0);
            layoutDesc.layoutConstantBuffer(2);
            layoutDesc.layoutPushConstants(1, MATERIAL_CONSTANT_SIZE);
            layoutDesc.layoutTextureSRV(12);
            layoutDesc.layoutTextureSRV(13);
            layoutDesc.layoutSampler(10);
            layoutDesc.layoutSampler(11);
            this.rasterLayout = app.createBindingLayout(layoutDesc, ShaderType.All);
            this.cameraVSConstants = app.createConstantBuffer(VS_CONSTANTS_SIZE, "Camera VSConstants");
            this.shadowVSConstants = app.createConstantBuffer(VS_CONSTANTS_SIZE, "Shadow VSConstants");
            this.psConstantBuffer = app.createConstantBuffer(PS_CONSTANTS_SIZE, "PSConstants");
            return true;
        }

        private createCompute(file: string, srvCount: int, uavCount: int): MiniEngineCompute | null {
            const layoutDesc = BindingLayoutDesc.create();
            for (let t = 0; t < srvCount; t++) {
                layoutDesc.layoutTextureSRV(t);
            }
            for (let u = 0; u < uavCount; u++) {
                layoutDesc.layoutTextureUAV(u);
            }
            layoutDesc.layoutConstantBuffer(0);
            layoutDesc.layoutConstantBuffer(1);
            layoutDesc.layoutSampler(0);
            layoutDesc.layoutSampler(1);
            const layout = this.app.createBindingLayout(layoutDesc, ShaderType.Compute);
            const shader = this.app.createShader(`raytracing_mini_engine/${file}`, "main", ShaderType.Compute);
            if (!shader) {
                return null;
            }
            const pipeline = this.app.createComputePipelineWithLayout(shader, layout);
            this.app.releaseResource(shader);
            return new MiniEngineCompute(layout, pipeline, srvCount, uavCount);
        }

        // SSAO::Initialize, MotionBlur::Initialize and TemporalEffects::Initialize: their compute
        // shaders, the static samplers of their root signatures (linear and clamped; linear or point
        // with a transparent black border), the constants.
        private createPostProcessing(): boolean {
            this.linearizeDepth = this.createCompute("LinearizeDepthCS.hlsl", 1, 1);
            this.prepareDepth1 = this.createCompute("AoPrepareDepthBuffers1CS.hlsl", 1, 5);
            this.prepareDepth2 = this.createCompute("AoPrepareDepthBuffers2CS.hlsl", 1, 4);
            this.aoRender1 = this.createCompute("AoRender1CS.hlsl", 1, 1);
            this.aoRender2 = this.createCompute("AoRender2CS.hlsl", 1, 1);
            this.aoBlurUpsampleFinal = this.createCompute("AoBlurUpsampleCS.hlsl", 3, 1);
            this.aoBlurUpsampleBlend = this.createCompute("AoBlurUpsamplePreMinBlendOutCS.hlsl", 5, 1);
            this.cameraVelocity = this.createCompute("CameraVelocityCS.hlsl", 1, 1);
            this.temporalBlend = this.createCompute("TemporalBlendCS.hlsl", 5, 1);
            this.sharpen = this.createCompute("SharpenTAACS.hlsl", 1, 1);
            if (!this.linearizeDepth || !this.prepareDepth1 || !this.prepareDepth2 || !this.aoRender1 || !this.aoRender2
                || !this.aoBlurUpsampleFinal || !this.aoBlurUpsampleBlend || !this.cameraVelocity || !this.temporalBlend
                || !this.sharpen) {
                return false;
            }
            const app = this.app;
            this.computeCB0 = app.createConstantBuffer(COMPUTE_CONSTANTS_SIZE, "MiniEngine compute constants b0");
            this.computeCB1 = app.createConstantBuffer(COMPUTE_CONSTANTS_SIZE, "MiniEngine compute constants b1");
            this.linearClampSampler = app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Clamp, 0.0, 0.0, 3.402823466e+38, 1.0);
            this.linearBorderSampler = app.createBorderSampler(1, 1, 1, 0.0, 0.0, 0.0, 0.0);
            this.pointBorderSampler = app.createBorderSampler(0, 0, 0, 0.0, 0.0, 0.0, 0.0);
            return true;
        }

        // Records one of MiniEngine's compute dispatches: its textures (SRVs and UAVs by register),
        // constants b0 and b1 (the first floats of each; null: zeros), the root signature's
        // second static sampler (SSAO's linear border one, or the common root signature's point one).
        private dispatchCompute(commandList: CommandList, compute: MiniEngineCompute | null, srvs: TextureHandle[],
            uavs: TextureHandle[], cb0: number[] | null, cb1: number[] | null, pointSampler: boolean,
            groupsX: int, groupsY: int, groupsZ: int) {
            if (!compute) {
                return;
            }
            // Both constant buffers are rewritten before every dispatch (zeros where the shader has none);
            // the command list orders each write before the dispatch that reads it.
            const constants = this.computeConstants;
            const values0: number[] = cb0 ? cb0 as number[] : [];
            for (let i = 0; i < constants.length; i++) {
                constants[i] = i < values0.length ? values0[i] : 0.0;
            }
            commandList.writeBuffer(this.computeCB0 as BufferHandle, Ref(constants[0]), COMPUTE_CONSTANTS_SIZE);
            const values1: number[] = cb1 ? cb1 as number[] : [];
            for (let i = 0; i < constants.length; i++) {
                constants[i] = i < values1.length ? values1[i] : 0.0;
            }
            commandList.writeBuffer(this.computeCB1 as BufferHandle, Ref(constants[0]), COMPUTE_CONSTANTS_SIZE);
            const desc = BindingSetDesc.create();
            for (let t = 0; t < compute.srvCount; t++) {
                desc.bindTextureSRV(t, srvs[t]);
            }
            for (let u = 0; u < compute.uavCount; u++) {
                desc.bindTextureUAV(u, uavs[u]);
            }
            desc.bindConstantBuffer(0, this.computeCB0 as BufferHandle, 0, COMPUTE_CONSTANTS_SIZE);
            desc.bindConstantBuffer(1, this.computeCB1 as BufferHandle, 0, COMPUTE_CONSTANTS_SIZE);
            desc.bindSampler(0, this.linearClampSampler as SamplerHandle);
            desc.bindSampler(1, (pointSampler ? this.pointBorderSampler : this.linearBorderSampler) as SamplerHandle);
            const set = this.app.createBindingSetForLayout(desc, compute.layout);
            commandList.dispatch(compute.pipeline, set, groupsX, groupsY, groupsZ);
            // The command list holds it until the GPU is done with it.
            this.app.releaseResource(set.handle);
        }

        // A pipeline of the depth passes (DepthViewerVS, DepthViewerPS for cutouts) or the color pass
        // (ModelViewerVS and PS): MiniEngine's rasterizer states (counterclockwise fronts, culled
        // backs unless two-sided, depth clipping, its shadows' depth bias) and reversed depth (greater or equal,
        // written; the color pass equal, not written).
        private createRasterPipeline(framebuffer: FramebufferHandle, color: boolean, cutout: boolean, shadow: boolean): GraphicsPipelineHandle {
            const vs = color ? this.modelVS : this.depthVS;
            const ps = color ? this.modelPS : cutout ? this.depthPS : null;
            const desc = GraphicsPipelineDesc.create(vs as ShaderHandle, ps);
            desc.addBindingLayout(this.rasterLayout as BindingLayoutHandle);
            desc.addBindingLayout(this.bindlessLayout as BindingLayoutHandle);
            desc.setInputLayout((color ? this.inputLayout : this.depthInputLayout) as InputLayoutHandle);
            desc.setRasterState(cutout ? CullMode.None : CullMode.Back, FillMode.Solid, 1);
            desc.setDepthClip(true);
            desc.setScissorEnable(true);
            if (shadow) {
                desc.setDepthBias(-100, 0.0, -1.5);
            }
            if (color) {
                desc.setDepthState(1, 0, ComparisonFunc.Equal);
            } else {
                desc.setDepthState(1, 1, ComparisonFunc.GreaterOrEqual);
            }
            return this.app.createGraphicsPipelineFromDesc(desc, framebuffer);
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
        // FlyingFPSCamera's inputs: the movement keys held, fine movement (left shift), the mouse's
        // motion while its left button is held.
        private keysHeld: boolean[] = [false, false, false, false, false, false];
        private fineMovement: boolean = false;
        private mouseLook: boolean = false;
        private mouseX: number = 0.0;
        private mouseY: number = 0.0;
        private mouseDeltaX: number = 0.0;
        private mouseDeltaY: number = 0.0;

        // -dumpScene: the normals, SSAO, the temporal color the last frame wrote, the depth.
        dumpedTextures(): TextureHandle[] {
            return [this.sceneNormals as TextureHandle, this.ssao as TextureHandle, this.temporalColor[(this.frameIndex + 1) % 2],
                this.sceneDepth as TextureHandle];
        }

        // -dumpScene: the camera's matrices as the reference dump has them (view, proj, viewProj,
        // cameraToWorld, position), the sun's shadow matrix and view-projection matrix, the sun.
        cameraMatrices(): f32[] {
            const c = this.camera;
            const values: f32[] = [];
            for (const m of [c.view, c.proj, c.viewProj, c.cameraToWorld, c.position, this.sunShadow.shadowMatrix,
                this.sunShadow.viewProj, this.sunDirection()]) {
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
            const movementKeys = [Key.W, Key.S, Key.D, Key.A, Key.E, Key.Q];
            for (let k = 0; k < movementKeys.length; k++) {
                if (key == movementKeys[k]) {
                    if (action != Action.Repeat) {
                        this.keysHeld[k] = action == Action.Press;
                    }
                    return 1;
                }
            }
            if (action != Action.Press) {
                return 0;
            }
            const settings = this.settings;
            if (key == Key.LeftShift) {
                this.fineMovement = !this.fineMovement;
                return 1;
            }
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

        onMouseButton(button: MouseButton, action: Action, mods: KeyMods): int {
            if (button == MouseButton.Left) {
                this.mouseLook = action == Action.Press;
                return 1;
            }
            return 0;
        }

        onMousePos(x: number, y: number): int {
            if (this.mouseLook) {
                this.mouseDeltaX += x - this.mouseX;
                this.mouseDeltaY += y - this.mouseY;
            }
            this.mouseX = x;
            this.mouseY = y;
            return this.mouseLook ? 1 : 0;
        }

        onBackBufferResizing() {
            for (const set of [this.rayTracingSet, this.cameraRasterSet, this.shadowRasterSet]) {
                if (!set.isNull()) {
                    this.app.releaseResource(set.handle);
                }
            }
            this.rayTracingSet = new BindingSet(null);
            this.cameraRasterSet = new BindingSet(null);
            this.shadowRasterSet = new BindingSet(null);
            for (const pipeline of [this.depthOpaquePipeline, this.depthCutoutPipeline, this.colorOpaquePipeline,
                this.colorCutoutPipeline]) {
                if (pipeline) {
                    this.app.releaseResource(pipeline);
                }
            }
            this.depthOpaquePipeline = null;
            this.depthCutoutPipeline = null;
            this.colorOpaquePipeline = null;
            this.colorCutoutPipeline = null;
            for (const framebuffer of [this.depthFramebuffer, this.colorFramebuffer]) {
                if (framebuffer) {
                    this.app.releaseResource(framebuffer);
                }
            }
            this.depthFramebuffer = null;
            this.colorFramebuffer = null;
            for (const texture of [this.sceneColor, this.sceneDepth, this.sceneNormals, this.ssao]) {
                if (texture) {
                    this.app.releaseResource(texture);
                }
            }
            this.sceneColor = null;
            this.sceneDepth = null;
            this.sceneNormals = null;
            this.ssao = null;
            this.releasePostTargets();
        }

        onAnimate(elapsedSeconds: number) {
            this.app.setInformativeWindowTitle(`${WINDOW_TITLE} - ${MODE_NAMES[this.settings.mode - 1]}`);
            // FlyingFPSCamera::Update (its move and strafe speeds 1000 a second, a tenth with fine
            // movement; GameInput's mouse scale 0.0018 a pixel), unless frozen.
            if (!this.settings.frozen) {
                const step = Math.fround(1000.0 * (this.fineMovement ? 0.1 : 1.0) * elapsedSeconds);
                const held = this.keysHeld;
                const forward = (held[0] ? step : 0.0) - (held[1] ? step : 0.0);
                const strafe = (held[2] ? step : 0.0) - (held[3] ? step : 0.0);
                const ascent = (held[4] ? step : 0.0) - (held[5] ? step : 0.0);
                const yaw = this.mouseDeltaX * 0.0018;
                const pitch = -this.mouseDeltaY * 0.0018;
                this.mouseDeltaX = 0.0;
                this.mouseDeltaY = 0.0;
                this.camera.move(yaw, pitch, forward, strafe, ascent);
            }
        }

        // The buffers at the back buffers' size (MiniEngine's native resolution): the scene color
        // (R11G11B10_FLOAT, what the ray tracing writes), depth (D32, reversed), normals, SSAO; the
        // 2048 x 2048 sun shadow map (D16). Their framebuffers, the raster pipelines, the binding sets.
        private createTargets(width: int, height: int) {
            const app = this.app;
            this.sceneColor = app.createRenderTargetUAVTexture(width, height, Format.R11G11B10_FLOAT, "Main Color Buffer");
            this.sceneDepth = app.createDepthTexture(width, height, Format.D32, 0.0, "Scene Depth Buffer");
            this.sceneNormals = app.createRenderTargetTexture(width, height, Format.RGBA16_FLOAT, "Normals Buffer");
            this.ssao = app.createRenderTargetUAVTexture(width, height, Format.R8_UNORM, "SSAO Full Res");
            if (!this.shadowMap) {
                const shadowMap = app.createDepthTexture(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, Format.D16, 0.0, "Shadow Map");
                this.shadowMap = shadowMap;
                this.shadowFramebuffer = app.createDepthFramebuffer(shadowMap);
                this.shadowOpaquePipeline = this.createRasterPipeline(this.shadowFramebuffer as FramebufferHandle, false, false, true);
                this.shadowCutoutPipeline = this.createRasterPipeline(this.shadowFramebuffer as FramebufferHandle, false, true, true);
            }
            const depthFramebuffer = app.createDepthFramebuffer(this.sceneDepth as TextureHandle);
            const colorFramebuffer = app.createFramebufferWithTwoTargets(this.sceneColor as TextureHandle,
                this.sceneNormals as TextureHandle, this.sceneDepth);
            this.depthFramebuffer = depthFramebuffer;
            this.colorFramebuffer = colorFramebuffer;
            this.depthOpaquePipeline = this.createRasterPipeline(depthFramebuffer, false, false, false);
            this.depthCutoutPipeline = this.createRasterPipeline(depthFramebuffer, false, true, false);
            this.colorOpaquePipeline = this.createRasterPipeline(colorFramebuffer, true, false, false);
            this.colorCutoutPipeline = this.createRasterPipeline(colorFramebuffer, true, true, false);
            this.createPostTargets(width, height);
            this.cameraRasterSet = this.createRasterSet(this.cameraVSConstants as BufferHandle);
            this.shadowRasterSet = this.createRasterSet(this.shadowVSConstants as BufferHandle);

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

        // BufferManager's buffers of SSAO and the temporal effects at the scene's size: the linear
        // depths (R16_UNORM), velocities (R32_UINT), temporal colors (RGBA16_FLOAT); SSAO's depths
        // downsized 2x to 16x (R32_FLOAT), deinterleaved into 16-slice atlases of 1/8 to 1/64 the size
        // (R16_FLOAT), occlusion at 1/2 to 1/16 (R8_UNORM).
        private createPostTargets(width: int, height: int) {
            const app = this.app;
            for (let i = 0; i < 2; i++) {
                this.linearDepth.push(app.createUAVTextureWithFormat(width, height, Format.R16_UNORM, `Linear Depth ${i}`));
                this.temporalColor.push(app.createRenderTargetUAVTexture(width, height, Format.RGBA16_FLOAT, `Temporal Color ${i}`));
            }
            this.velocity = app.createUAVTextureWithFormat(width, height, Format.R32_UINT, "Motion Vectors");
            for (let level = 1; level <= 4; level++) {
                const w = divideUp(width, level);
                const h = divideUp(height, level);
                this.depthDownsize.push(app.createUAVTextureWithFormat(w, h, Format.R32_FLOAT, `Depth Down-Sized ${level}`));
                this.depthTiled.push(app.createUAVTextureArray(divideUp(width, level + 2), divideUp(height, level + 2), 16,
                    Format.R16_FLOAT, `Depth De-Interleaved ${level}`));
                this.aoMerged.push(app.createUAVTextureWithFormat(w, h, Format.R8_UNORM, `AO Re-Interleaved ${level}`));
                this.aoHighQuality.push(app.createUAVTextureWithFormat(w, h, Format.R8_UNORM, `AO High Quality ${level}`));
                if (level <= 3) {
                    this.aoSmooth.push(app.createUAVTextureWithFormat(w, h, Format.R8_UNORM, `AO Smoothed ${level}`));
                }
            }
            this.postTargetsCleared = false;
            this.frameIndex = 0;
        }

        private releasePostTargets() {
            const textures: TextureHandle[] = [];
            for (const list of [this.linearDepth, this.temporalColor, this.depthDownsize, this.depthTiled, this.aoMerged,
                this.aoHighQuality, this.aoSmooth]) {
                for (const texture of list) {
                    textures.push(texture);
                }
            }
            if (this.velocity) {
                textures.push(this.velocity as TextureHandle);
            }
            for (const texture of textures) {
                this.app.releaseResource(texture);
            }
            this.linearDepth = [];
            this.temporalColor = [];
            this.depthDownsize = [];
            this.depthTiled = [];
            this.aoMerged = [];
            this.aoHighQuality = [];
            this.aoSmooth = [];
            this.velocity = null;
        }

        // SSAO::Render: with SSAO off, its buffer cleared to 1 and the depth linearized (ComputeLinearZ);
        // on, the depth linearized, downsized and deinterleaved (phase 1), occlusion from each level's
        // atlas and (high quality) downsized depths (phase 2, levels 3 to 1 - MiniEngine's hierarchy
        // depth 3, quality high), then blurred and upsampled level by level into the full-size buffer.
        private renderSsao(commandList: CommandList, width: int, height: int) {
            const linearDepth = this.linearDepth[this.frameIndex % 2];
            const zMagic = Math.fround(Math.fround(10000.0 - 1.0) / 1.0);
            const groups = (size: int, group: int): int => Math.floor((size + group - 1) / group);
            if (!this.settings.ssao) {
                commandList.clearTextureFloat(this.ssao as TextureHandle, 1.0, 1.0, 1.0, 1.0);
                this.dispatchCompute(commandList, this.linearizeDepth, [this.sceneDepth as TextureHandle], [linearDepth],
                    [zMagic], null, false, groups(width, 16), groups(height, 16), 1);
                return;
            }
            const down = this.depthDownsize;
            const tiled = this.depthTiled;
            const tiledSize = (level: int, w: boolean): int => divideUp(w ? width : height, level + 3);
            this.ssaoConstants = [];
            // Phase 1.
            this.dispatchCompute(commandList, this.prepareDepth1, [this.sceneDepth as TextureHandle],
                [linearDepth, down[0], tiled[0], down[1], tiled[1]], [zMagic], null, false,
                tiledSize(1, true), tiledSize(1, false), 1);
            const down2Width = divideUp(width, 2);
            const down2Height = divideUp(height, 2);
            this.dispatchCompute(commandList, this.prepareDepth2, [down[1]], [down[2], tiled[2], down[3], tiled[3]],
                [Math.fround(1.0 / down2Width), Math.fround(1.0 / down2Height)], null, false,
                tiledSize(3, true), tiledSize(3, false), 1);
            // Phase 2: FovTangent = 1 / proj[0].
            const fovTangent = Math.fround(1.0 / this.camera.proj[0]);
            for (let level = 3; level >= 1; level--) {
                this.computeAO(commandList, this.aoRender1, this.aoMerged[level - 1], tiled[level - 1],
                    divideUp(width, level + 2), divideUp(height, level + 2), 16, fovTangent);
                if (level >= 2) {
                    this.computeAO(commandList, this.aoRender2, this.aoHighQuality[level - 1], down[level - 1],
                        divideUp(width, level), divideUp(height, level), 1, fovTangent);
                }
            }
            // Phase 4: 3 -> 2 -> 1 -> full size.
            this.blurAndUpsample(commandList, this.aoBlurUpsampleBlend, this.aoSmooth[1], down[1], down[2], this.aoMerged[2],
                this.aoHighQuality[2], this.aoMerged[1], divideUp(width, 2), divideUp(height, 2), divideUp(width, 3), divideUp(height, 3));
            this.blurAndUpsample(commandList, this.aoBlurUpsampleBlend, this.aoSmooth[0], down[0], down[1], this.aoSmooth[1],
                this.aoHighQuality[1], this.aoMerged[0], divideUp(width, 1), divideUp(height, 1), divideUp(width, 2), divideUp(height, 2));
            this.blurAndUpsample(commandList, this.aoBlurUpsampleFinal, this.ssao as TextureHandle, linearDepth, down[0],
                this.aoSmooth[0], null, null, width, height, divideUp(width, 1), divideUp(height, 1));
        }

        // SSAO::ComputeAO, as MiniEngine's /fp:fast build computes it: the reciprocals of the sample
        // thicknesses at the center depth (a sphere 10 pixels across, twice as thick for the
        // non-interleaved depths) and the samples' normalized weights - its divisions by the thicknesses
        // and by the weights' sum are SSE reciprocal estimates refined by a Newton-Raphson step
        // (Donut_ApproxRcpf), the sum taken in its vectorized order.
        private computeAO(commandList: CommandList, compute: MiniEngineCompute | null, destination: TextureHandle,
            depth: TextureHandle, w: int, h: int, arrayCount: int, tanHalfFovH: number) {
            const f = (x: number): number => Math.fround(x);
            const reciprocal = (x: number): number => {
                const r = f(Donut_ApproxRcpf(x));
                return f(f(r + r) - f(f(r * r) * x));
            };
            const thickness = SSAO_SAMPLE_THICKNESS;
            let thicknessMultiplier = f(f(tanHalfFovH * 20.0) / w);
            if (arrayCount == 1) {
                thicknessMultiplier = f(thicknessMultiplier + thicknessMultiplier);
            }
            const inverseRangeFactor = f(1.0 / thicknessMultiplier);
            const cb: number[] = [];
            for (let i = 0; i < 12; i++) {
                cb.push(f(reciprocal(thickness[i]) * inverseRangeFactor));
            }
            // Axial, diagonal and L-shaped weights; the unsampled ones (not SAMPLE_EXHAUSTIVELY) zero.
            const counts = [0.0, 4.0, 0.0, 4.0, 4.0, 0.0, 8.0, 0.0, 4.0, 0.0, 8.0, 4.0];
            const weights: number[] = [];
            for (let i = 0; i < 12; i++) {
                weights.push(f(counts[i] * thickness[i]));
            }
            const totalWeight = f(f(f(f(f(weights[1] + weights[3]) + f(weights[4] + weights[6])) + weights[8]) + weights[10])
                + weights[11]);
            const rcpTotal = reciprocal(totalWeight);
            for (let i = 0; i < 12; i++) {
                cb.push(f(rcpTotal * weights[i]));
            }
            cb.push(f(1.0 / w));
            cb.push(f(1.0 / h));
            cb.push(f(-1.0 / 2.5));
            cb.push(f(1.0 / f(f(0.1) + 1.0)));
            for (const v of cb) {
                this.ssaoConstants.push(v);
            }
            const groupsX = arrayCount == 1 ? Math.floor((w + 15) / 16) : Math.floor((w + 7) / 8);
            const groupsY = arrayCount == 1 ? Math.floor((h + 15) / 16) : Math.floor((h + 7) / 8);
            this.dispatchCompute(commandList, compute, [depth], [destination], null, cb, false, groupsX, groupsY, arrayCount);
        }

        // SSAO::BlurAndUpsample: the low resolution occlusion (and high quality occlusion, blended with
        // the higher resolution one when given) blurred and upsampled by the depths, its tolerances from
        // MiniEngine's settings (blur 10^-5, upsample 10^-7, noise filter 10^-3; its /fp:fast build
        // multiplies by 1 / loWidth where the source divides by loWidth).
        private blurAndUpsample(commandList: CommandList, compute: MiniEngineCompute | null, destination: TextureHandle,
            hiResDepth: TextureHandle, loResDepth: TextureHandle, interleavedAO: TextureHandle, highQualityAO: TextureHandle | null,
            hiResAO: TextureHandle | null, hiWidth: int, hiHeight: int, loWidth: int, loHeight: int) {
            const f = (x: number): number => Math.fround(x);
            const rcpLoWidth = f(1.0 / loWidth);
            let blurTolerance = f(1.0 - f(f(f(Math.pow(10.0, -5.0)) * 1920.0) * rcpLoWidth));
            blurTolerance = f(blurTolerance * blurTolerance);
            const upsampleTolerance = f(Math.pow(10.0, -7.0));
            const noiseFilterWeight = f(1.0 / f(f(Math.pow(10.0, -3.0)) + upsampleTolerance));
            const cb = [rcpLoWidth, f(1.0 / loHeight), f(1.0 / hiWidth), f(1.0 / hiHeight), noiseFilterWeight,
                f(rcpLoWidth * 1920.0), blurTolerance, upsampleTolerance];
            for (const v of cb) {
                this.ssaoConstants.push(v);
            }
            const srvs = [loResDepth, hiResDepth, interleavedAO, (highQualityAO ? highQualityAO : interleavedAO) as TextureHandle,
                (hiResAO ? hiResAO : interleavedAO) as TextureHandle];
            this.dispatchCompute(commandList, compute, srvs, [destination], null, cb, false,
                Math.floor((hiWidth + 2 + 15) / 16), Math.floor((hiHeight + 2 + 15) / 16), 1);
        }

        // MotionBlur::GenerateCameraVelocityBuffer (linear z) and TemporalEffects::ResolveImage: the
        // camera's reprojection from pixels and linear depth to the previous frame's, the TAA blend of
        // the scene color with the temporal color (MiniEngine runs it with TAA off too: a blend factor
        // of 1, the speed limit 64), then sharpening (0.5) back into the scene color.
        private resolveImage(commandList: CommandList, width: int, height: int) {
            const f = (x: number): number => Math.fround(x);
            const src = this.frameIndex % 2;
            const dst = src ^ 1;
            const rcpHalfDimX = f(2.0 / width);
            const rcpHalfDimY = f(2.0 / height);
            const rcpZMagic = f(1.0 / f(10000.0 - 1.0));
            const preMult = [rcpHalfDimX, 0.0, 0.0, 0.0, 0.0, -rcpHalfDimY, 0.0, 0.0, 0.0, 0.0, rcpZMagic, 0.0, -1.0, 1.0, -rcpZMagic, 1.0];
            const postMult = [f(1.0 / rcpHalfDimX), 0.0, 0.0, 0.0, 0.0, f(-1.0 / rcpHalfDimY), 0.0, 0.0, 0.0, 0.0, 1.0, 0.0,
                f(1.0 / rcpHalfDimX), f(1.0 / rcpHalfDimY), 0.0, 1.0];
            // postMult * reprojection * preMult (MiniEngine's Matrix4 product a * b is XMMatrixMultiply(b, a)).
            const curToPrev = matrixMultiply(preMult, matrixMultiply(this.camera.reprojection, postMult));
            this.dispatchCompute(commandList, this.cameraVelocity, [this.linearDepth[src]], [this.velocity as TextureHandle],
                null, curToPrev, false, Math.floor((width + 7) / 8), Math.floor((height + 7) / 8), 1);
            this.dispatchCompute(commandList, this.temporalBlend,
                [this.velocity as TextureHandle, this.sceneColor as TextureHandle, this.temporalColor[src], this.linearDepth[src],
                    this.linearDepth[dst]], [this.temporalColor[dst]],
                null, [f(1.0 / width), f(1.0 / height), 1.0, f(1.0 / 64.0), 0.0, 0.0], true,
                Math.floor((width + 15) / 16), Math.floor((height + 7) / 8), 1);
            this.dispatchCompute(commandList, this.sharpen, [this.temporalColor[dst]], [this.sceneColor as TextureHandle],
                [1.5, 0.125], null, true, Math.floor((width + 7) / 8), Math.floor((height + 7) / 8), 1);
        }

        private createRasterSet(vsConstants: BufferHandle): BindingSet {
            const desc = BindingSetDesc.create();
            desc.bindConstantBuffer(0, vsConstants, 0, VS_CONSTANTS_SIZE);
            desc.bindConstantBuffer(2, this.psConstantBuffer as BufferHandle, 0, PS_CONSTANTS_SIZE);
            desc.bindPushConstants(1, MATERIAL_CONSTANT_SIZE);
            desc.bindTextureSRV(12, this.ssao as TextureHandle);
            desc.bindTextureSRV(13, this.shadowMap as TextureHandle);
            desc.bindSampler(10, this.defaultSampler as SamplerHandle);
            desc.bindSampler(11, this.shadowSampler as SamplerHandle);
            return this.app.createBindingSetForLayout(desc, this.rasterLayout as BindingLayoutHandle);
        }

        // Sponza::RenderScene's sun: from its orientation (-0.5) and inclination (0.75), normalized - the
        // sines and cosines as MiniEngine's /fp:fast build computes them (Donut_FastSinCosf).
        private sunDirection(): number[] {
            const theta: f32[] = [0.0, 0.0];
            Donut_FastSinCosf(-0.5, Ref(theta[0]));
            const phi: f32[] = [0.0, 0.0];
            Donut_FastSinCosf(Math.fround(Math.fround(Math.fround(0.75) * Math.fround(3.14159)) * 0.5), Ref(phi[0]));
            const costheta = theta[1];
            const sintheta = theta[0];
            const cosphi = phi[1];
            const sinphi = phi[0];
            const x = Math.fround(costheta * cosphi);
            const z = Math.fround(sintheta * cosphi);
            // Vector3(x, y, z)'s w is z.
            return normalize3([x, sinphi, z, z]);
        }

        // The sun's light (4) and the ambient light (0.1), each through ExpVar's exp2f(log2f(value)).
        private sunLight(): number {
            return Math.fround(Donut_Exp2f(Donut_Log2f(4.0)));
        }

        private ambientLight(): number {
            return Math.fround(Donut_Exp2f(Donut_Log2f(Math.fround(0.1))));
        }

        // HitShaderConstants: zeros for the barycentric modes; else the sun, its light, the ambient
        // light, the shadow map's texel size and its matrix (transposed but by RaytraceShadows), whether
        // the hit shader adds to a reflected surface, and whether it traces shadow rays.
        private writeHitConstants(commandList: CommandList, lit: boolean, transposeShadow: boolean, isReflection: boolean,
            useShadowRays: boolean) {
            const c = this.hitConstants;
            for (let i = 0; i < c.length; i++) {
                c[i] = 0.0;
            }
            if (lit) {
                const sun = this.sunDirection();
                const sunLight = this.sunLight();
                const ambient = this.ambientLight();
                for (let i = 0; i < 4; i++) {
                    c[i] = sun[i];
                    c[4 + i] = sunLight;
                    c[8 + i] = ambient;
                }
                c[12] = Math.fround(1.0 / SHADOW_MAP_SIZE);
                const shadow = transposeShadow ? matrixTranspose(this.sunShadow.shadowMatrix) : this.sunShadow.shadowMatrix;
                for (let i = 0; i < 16; i++) {
                    c[16 + i] = shadow[i];
                }
            }
            commandList.writeBuffer(this.hitConstantBuffer as BufferHandle, Ref(c[0]), HIT_CONSTANTS_SIZE);
            // IsReflection and UseShadowRays (uints at 128).
            const bits: int[] = [isReflection ? 1 : 0, useShadowRays ? 1 : 0];
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

        // RenderObjects' VSConstants: modelToProjection, modelToShadow (the sun's shadow matrix), the
        // viewer's position.
        private writeVSConstants(commandList: CommandList, buffer: BufferHandle, modelToProjection: number[]) {
            const c = this.vsConstants;
            const shadow = this.sunShadow.shadowMatrix;
            for (let i = 0; i < 16; i++) {
                c[i] = modelToProjection[i];
                c[16 + i] = shadow[i];
            }
            const position = this.camera.position;
            for (let i = 0; i < 3; i++) {
                c[32 + i] = position[i];
            }
            commandList.writeBuffer(buffer, Ref(c[0]), VS_CONSTANTS_SIZE);
        }

        // RenderScene's PSConstants: the sun, its light, the ambient light, the shadow map's texel size
        // (the light grid's members unused here).
        private writePSConstants(commandList: CommandList) {
            const c = this.psConstants;
            const sun = this.sunDirection();
            const sunLight = this.sunLight();
            const ambient = this.ambientLight();
            for (let i = 0; i < 4; i++) {
                c[i] = sun[i];
                c[4 + i] = sunLight;
                c[8 + i] = ambient;
            }
            c[12] = Math.fround(1.0 / SHADOW_MAP_SIZE);
            commandList.writeBuffer(this.psConstantBuffer as BufferHandle, Ref(c[0]), PS_CONSTANTS_SIZE);
        }

        // Sponza::RenderObjects: each mesh of the filter's materials (cutouts or not), its material's
        // textures and index, at its indices and base vertex. MiniEngine's viewport has TAA's +0.5
        // jitter offset even with TAA off (TemporalEffects::GetJitterOffset); the shadow map's
        // scissor leaves out its edge texels.
        private renderObjects(frame: Frame, pipeline: GraphicsPipelineHandle, framebuffer: FramebufferHandle, set: BindingSet,
            cutouts: boolean, shadow: boolean, width: int, height: int) {
            const model = this.model;
            for (const mesh of model.meshes) {
                if (this.materialIsCutout[mesh.materialIndex] != cutouts) {
                    continue;
                }
                frame.beginDrawToFramebuffer(pipeline, framebuffer);
                frame.drawAddBindingSet(set);
                frame.drawAddDescriptorTable(this.textureTable as DescriptorTableHandle);
                frame.drawSetIndexBuffer16(this.indexBuffer as BufferHandle);
                frame.drawAddVertexBuffer(this.vertexBuffer as BufferHandle, 0, 0);
                if (shadow) {
                    frame.drawSetViewport(0.0, 0.0, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
                    frame.drawSetScissor(1, 1, SHADOW_MAP_SIZE - 2, SHADOW_MAP_SIZE - 2);
                } else {
                    frame.drawSetViewport(0.5, 0.5, width, height);
                    frame.drawSetScissor(0, 0, width, height);
                }
                this.materialConstant[0] = mesh.materialIndex;
                frame.drawIndexedRangeWithPushConstants(mesh.indexCount, mesh.indexDataByteOffset / 2,
                    mesh.vertexDataByteOffset / mesh.vertexStride, Ref(this.materialConstant[0]), MATERIAL_CONSTANT_SIZE);
            }
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
            const mode = this.settings.mode;
            const skipDiffusePass = mode == MODE_DIFFUSE_SHADOW_MAPS || mode == MODE_DIFFUSE_SHADOW_RAYS || mode == MODE_BARYCENTRICS;
            const skipShadowMap = mode == MODE_DIFFUSE_SHADOW_RAYS || mode == MODE_BARYCENTRICS || mode == MODE_REFLECTION_BARYCENTRICS;
            const depthFramebuffer = this.depthFramebuffer as FramebufferHandle;
            const colorFramebuffer = this.colorFramebuffer as FramebufferHandle;

            // Sponza::RenderScene: the depth prepass (opaque, then cutouts).
            this.writeVSConstants(commandList, this.cameraVSConstants as BufferHandle, this.camera.viewProj);
            this.writePSConstants(commandList);
            commandList.clearDepth(this.sceneDepth as TextureHandle, 0.0);
            this.renderObjects(frame, this.depthOpaquePipeline as GraphicsPipelineHandle, depthFramebuffer, this.cameraRasterSet,
                false, false, width, height);
            this.renderObjects(frame, this.depthCutoutPipeline as GraphicsPipelineHandle, depthFramebuffer, this.cameraRasterSet,
                true, false, width, height);

            // MiniEngine's buffers start zeroed (the temporal history, the previous linear depth).
            if (!this.postTargetsCleared) {
                for (let i = 0; i < 2; i++) {
                    commandList.clearTextureFloat(this.temporalColor[i], 0.0, 0.0, 0.0, 0.0);
                    commandList.clearTextureFloat(this.linearDepth[i], 0.0, 0.0, 0.0, 0.0);
                }
                this.postTargetsCleared = true;
            }
            this.renderSsao(commandList, width, height);

            if (!skipDiffusePass) {
                commandList.clearTextureFloat(this.sceneColor as TextureHandle, 0.0, 0.0, 0.0, 0.0);
            }
            // The sun's shadow map: its camera along the sun (centered at (0, -500, 0), bounds 5000 x
            // 3000 x 3000, 16-bit depth).
            if (!skipShadowMap) {
                const sun = this.sunDirection();
                this.sunShadow.updateMatrix(negate4(sun), [0.0, -500.0, 0.0, 0.0], [5000.0, 3000.0, 3000.0, 3000.0],
                    SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, 16);
                this.writeVSConstants(commandList, this.shadowVSConstants as BufferHandle, this.sunShadow.viewProj);
                // The camera's VSConstants carry the new shadow matrix too.
                this.writeVSConstants(commandList, this.cameraVSConstants as BufferHandle, this.camera.viewProj);
                const shadowFramebuffer = this.shadowFramebuffer as FramebufferHandle;
                commandList.clearDepth(this.shadowMap as TextureHandle, 0.0);
                this.renderObjects(frame, this.shadowOpaquePipeline as GraphicsPipelineHandle, shadowFramebuffer, this.shadowRasterSet,
                    false, true, width, height);
                this.renderObjects(frame, this.shadowCutoutPipeline as GraphicsPipelineHandle, shadowFramebuffer, this.shadowRasterSet,
                    true, true, width, height);
            }
            // The color pass (and the normals), at the prepass's depths.
            if (!skipDiffusePass) {
                this.renderObjects(frame, this.colorOpaquePipeline as GraphicsPipelineHandle, colorFramebuffer, this.cameraRasterSet,
                    false, false, width, height);
                this.renderObjects(frame, this.colorCutoutPipeline as GraphicsPipelineHandle, colorFramebuffer, this.cameraRasterSet,
                    true, false, width, height);
            }

            // The camera velocities and the temporal resolve (TAA blend, sharpening) into the scene color.
            this.resolveImage(commandList, width, height);

            // Raytrace.
            let pipeline = -1;
            if (mode == MODE_BARYCENTRICS) {
                pipeline = PIPELINE_PRIMARY_BARYCENTRIC;
                this.writeHitConstants(commandList, false, false, false, false);
            } else if (mode == MODE_REFLECTION_BARYCENTRICS) {
                pipeline = PIPELINE_REFLECTION_BARYCENTRIC;
                this.writeHitConstants(commandList, false, false, false, false);
            } else if (mode == MODE_SHADOW_RAYS) {
                pipeline = PIPELINE_SHADOWS;
                this.writeHitConstants(commandList, true, false, false, false);
            } else if (mode == MODE_DIFFUSE_SHADOW_MAPS || mode == MODE_DIFFUSE_SHADOW_RAYS) {
                pipeline = PIPELINE_DIFFUSE;
                this.writeHitConstants(commandList, true, true, false, mode == MODE_DIFFUSE_SHADOW_RAYS);
            } else if (mode == MODE_REFLECTIONS) {
                pipeline = PIPELINE_REFLECTION;
                this.writeHitConstants(commandList, true, true, true, false);
            }
            if (pipeline >= 0) {
                this.writeDynamicConstants(commandList, width, height);
                frame.dispatchRaysWithDescriptorTable(this.shaderTables[pipeline], this.rayTracingSet,
                    this.textureTable as DescriptorTableHandle, width, height);
            }
            this.app.blitTexture(frame, this.sceneColor as TextureHandle);
            // Graphics::Present's TemporalEffects::Update.
            this.frameIndex++;
        }
    }

    // -test (camera position 3, the second floor's view down the courtyard): the share of lit (not
    // black) pixels for the mode. Barycentrics cover every pixel that hits; the sample's shadow rays
    // (its known bug: aimed from the depth buffer's unprojection) light few; the shaded modes most,
    // with sunlit (bright) patches.
    function checkFrame(app: App, settings: Settings) {
        const check = new TestCheck(app);
        const failure = check.frameRead();
        if (failure != "") {
            return failure;
        }
        const w = check.width;
        const h = check.height;
        let lit = 0;
        let bright = 0;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const p = check.rgb(x, y);
                if (p != 0) {
                    lit++;
                }
                if ((p & 0xFF) >= 200 || ((p >> 8) & 0xFF) >= 200 || ((p >> 16) & 0xFF) >= 200) {
                    bright++;
                }
            }
        }
        const mode = settings.mode;
        if (mode == MODE_SHADOW_RAYS) {
            return check.share(lit, w * h, 0.05, 5.0, "Sunlit (shadow rays)");
        }
        if (mode == MODE_BARYCENTRICS) {
            return check.share(lit, w * h, 95.0, 100.0, "Hit (barycentrics)");
        }
        const litFailure = check.share(lit, w * h, 90.0, 100.0, "Lit");
        if (litFailure != "") {
            return litFailure;
        }
        // The sunlit patches of the floor and walls; everything is sunlit without the shadow map
        // (the reflection barycentrics mode skips it, as the sample's).
        if (mode == MODE_REFLECTION_BARYCENTRICS) {
            return check.share(bright, w * h, 15.0, 35.0, "Bright (no shadow map)");
        }
        return check.share(bright, w * h, 1.5, 4.0, "Bright (sunlit)");
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
            const textures = pass.dumpedTextures();
            const names = ["normals", "ssao", "temporal", "depth"];
            // Bytes a pixel: RGBA16_FLOAT, R8_UNORM, RGBA16_FLOAT, D32.
            const sizes = [8, 1, 8, 4];
            for (let t = 0; t < textures.length; t++) {
                const pixels: int[] = [];
                for (let i = 0; i < Math.floor((app.getWindowWidth() * app.getWindowHeight() * sizes[t] + 3) / 4); i++) {
                    pixels.push(0);
                }
                app.readTextureLevel(textures[t], 0, Ref(pixels[0]), pixels.length * 4);
                Donut_WriteBinaryFile(`${settings.dumpScenePath}/${names[t]}.raw`, Ref(pixels[0]), pixels.length * 4);
            }
        }
        if (settings.dumpScenePath != "") {
            const ssaoConstants = pass.ssaoConstants;
            if (ssaoConstants.length > 0) {
                Donut_WriteBinaryFile(`${settings.dumpScenePath}/ssaocb.raw`, Ref(ssaoConstants[0]), ssaoConstants.length * 4);
            }
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

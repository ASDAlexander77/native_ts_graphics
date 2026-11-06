// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, unsupported } from "../core/test_check";
import { Clas } from "../core/clas";
import {
    matrixInverse, matrixLookAtLH, matrixMultiply, matrixRotationRollPitchYaw, matrixScaling, matrixTranslation,
    normalize3, XM_PI,
} from "../core/directx_math";

// Port of DirectX-Graphics-Samples' D3D12RaytracingClusteredGeometry: procedural objects decomposed
// into clusters of up to 256 triangles, each cluster a CLAS (cluster level acceleration structure) built
// by GPU-driven operations whose arguments compute shaders write, each object a cluster BLAS of its
// CLASes; an animated sphere whose CLASes are instantiated every frame from cluster templates and the
// vertices a compute shader deforms; a spiral of clones, every fifth an animated one; glass, chrome and
// per-cluster colors keyed by ClusterID() in the hit shaders (shader model 6.10). The clustered path
// with FLOAT32_3 vertices (12 low mantissa bits truncated), implicit-destination CLASes (the sample's
// default compacts them after: the same image), fast-trace builds, 100 clones.
namespace ClusteredGeometry {
    const WINDOW_TITLE = "D3D12 Raytracing - Clustered Geometry";

    // RaytracingHlslCompat.h: NUM_MATERIAL_SLOTS, MAX_GEOMS_PER_INSTANCE, the animated sphere.
    const MATERIAL_SLOTS = 9;
    const MAX_GEOMS_PER_INSTANCE = 8;
    const ANIMATED_REST_RADIUS = 1.0;
    // sizeof(MaterialDesc), sizeof(ClusterMeta), sizeof(SceneConstantBuffer),
    // D3D12_RAYTRACING_INSTANCE_DESC, in bytes.
    const MATERIAL_SIZE = 32;
    const CLUSTER_META_SIZE = 48;
    const SCENE_CONSTANTS_SIZE = 144;
    const INSTANCE_SIZE = 64;
    // The indirect arguments of the operations (D3D12_RTAS_OPERATION_*_ARGS), in bytes; the shader-side
    // metadata the argument-filling shaders read per cluster / per BLAS.
    const CLAS_ARGS_SIZE = 80;
    const TEMPLATE_ARGS_SIZE = 96;
    const INSTANTIATE_ARGS_SIZE = 32;
    const BLAS_ARGS_SIZE = 16;
    const CLAS_ARGS_META_SIZE = 28;
    const TEMPLATE_ARGS_META_SIZE = 16;
    const BLAS_ARGS_META_SIZE = 12;
    // Payload: float4 color, uint depth, uint inGlass; attributes: the barycentrics.
    const PAYLOAD_SIZE = 24;
    const ATTRIBUTE_SIZE = 8;
    const MAX_RECURSION_DEPTH = 16;

    // core/clas.cpp's operation description (ClasParam) and D3D12's values.
    const CLAS_PARAM_COUNT = 17;
    const OP_BLAS_FROM_CLAS = 1;
    const OP_CLAS_FROM_TRIANGLES = 2;
    const OP_TEMPLATES_FROM_TRIANGLES = 3;
    const OP_INSTANTIATE_TEMPLATES = 4;
    const MODE_IMPLICIT = 0;
    const MODE_EXPLICIT = 1;
    const FLAG_FAST_TRACE = 4;
    const FLAG_ALLOW_DATA_ACCESS = 0x100;
    const VERTEX_FORMAT_FLOAT32_3 = 2;
    // D3D12_RTAS_CLUSTERED_GEOMETRY_FLAG_OPAQUE, D3D12_RAYTRACING_INSTANCE_FLAG_*.
    const CLUSTER_FLAG_OPAQUE = 1 << 31;
    const INSTANCE_FLAG_TRIANGLE_CULL_DISABLE = 1;
    const INSTANCE_FLAG_FORCE_OPAQUE = 4;
    // ProceduralGeometry.h's CLUSTER_FLAG_INTERIOR_SURFACE; ClusterMeta's flag for the animated sphere.
    const CLUSTER_FLAG_INTERIOR_SURFACE = 1;
    const CLUSTER_META_FLAG_ANIMATED_SPHERE = 2;
    // The hit group shader table: an opaque block, a glass one, a mixed one of a block per region (2
    // records each: primary + shadow), padded to every contribution + geometry index.
    const HIT_GROUP_OPAQUE = 0;
    const HIT_GROUP_GLASS = 2;
    const HIT_GROUP_MIXED = 4;
    const HIT_GROUP_RECORDS = 4 + 2 * MAX_GEOMS_PER_INSTANCE;
    // The sample's defaults: 12 truncated mantissa bits, 3 reflection and 5 refraction bounces, one
    // ray per pixel, the cluster color blend 0.65.
    const POSITION_TRUNCATE_BITS = 12;
    const REFLECTION_BOUNCES = 3;
    const REFRACTION_BOUNCES = 5;
    const CLUSTER_TINT = 0.65;
    const GROUP_SIZE = 64;

    // Test mode: the frames rendered (the sample's --screenshot 3: its fourth frame).
    const TEST_FRAMES = 4;

    const f = Math.fround;

    // The C runtime's float sinf / cosf (the sample's std::sin / std::cos of floats), which aren't always
    // correctly rounded; sqrtf (which is).
    function fsin(x: number): number {
        return Donut_Sinf(x);
    }

    function fcos(x: number): number {
        return Donut_Cosf(x);
    }

    function fsqrt(x: number): number {
        return Math.fround(Math.sqrt(x));
    }

    // std::max / std::min of floats (tslang's Math.max mishandles negatives).
    function fmax(a: number, b: number): number {
        return a < b ? b : a;
    }

    function fmin(a: number, b: number): number {
        return b < a ? b : a;
    }

    // f32 arrays with uint fields (RawMemory.storeInt32 writes their bits).
    function storeUint(array: f32[], index: int, value: int) {
        RawMemory.storeInt32(Ref(array[index]), value);
    }

    function zeros(count: int): f32[] {
        const array: f32[] = [];
        for (let i = 0; i < count; i++) {
            array.push(0.0);
        }
        return array;
    }

    // Packs bytes into the words of a f32 array (at a byte offset, 4-byte aligned).
    function storeBytes(array: f32[], byteOffset: int, bytes: int[]) {
        for (let i = 0; i < bytes.length; i += 4) {
            let word = 0;
            for (let k = 0; k < 4 && i + k < bytes.length; k++) {
                word = word | ((bytes[i + k] & 0xFF) << (8 * k));
            }
            storeUint(array, (byteOffset + i) / 4, word);
        }
    }

    function alignUp(value: int, alignment: int): int {
        return Math.floor((value + alignment - 1) / alignment) * alignment;
    }

    // ---- ProceduralGeometry.h ----------------------------------------------------------------

    // A cluster: its own vertices (positions and the analytic normals the hit shaders read) and up to
    // 256 triangles of 8-bit indices into them; its grid coordinates (the checker parity), the cluster
    // whose color it shows, its flags and material region.
    class Cluster {
        clusterID: int = 0;
        positions: number[] = [];
        normals: number[] = [];
        indices: int[] = [];
        gridU: int = 0;
        gridV: int = 0;
        matchedColorCid: int = 0;
        flags: int = 0;
        matRegionIdx: int = 0;

        vertexCount(): int {
            return this.positions.length / 3;
        }

        triangleCount(): int {
            return this.indices.length / 3;
        }

        // A copy sharing the vertex and index data (which nothing changes).
        clone(): Cluster {
            const c = new Cluster();
            c.clusterID = this.clusterID;
            c.positions = this.positions;
            c.normals = this.normals;
            c.indices = this.indices;
            c.gridU = this.gridU;
            c.gridV = this.gridV;
            c.matchedColorCid = this.matchedColorCid;
            c.flags = this.flags;
            c.matRegionIdx = this.matRegionIdx;
            return c;
        }
    }

    class Mesh {
        clusters: Cluster[] = [];
        totalTriangles: int = 0;
        totalVertices: int = 0;

        clone(): Mesh {
            const m = new Mesh();
            for (const c of this.clusters) {
                m.clusters.push(c.clone());
            }
            m.totalTriangles = this.totalTriangles;
            m.totalVertices = this.totalVertices;
            return m;
        }
    }

    // Two triangles per quad of a (rows + 1) x (columns + 1) vertex grid: (i00, i11, i10), (i00, i01, i11).
    function gridTriangles(c: Cluster, rows: int, columns: int) {
        const rowSize = columns + 1;
        for (let li = 0; li < rows; li++) {
            for (let lj = 0; lj < columns; lj++) {
                const i00 = li * rowSize + lj;
                const i01 = li * rowSize + lj + 1;
                const i10 = (li + 1) * rowSize + lj;
                const i11 = (li + 1) * rowSize + lj + 1;
                c.indices.push(i00);
                c.indices.push(i11);
                c.indices.push(i10);
                c.indices.push(i00);
                c.indices.push(i01);
                c.indices.push(i11);
            }
        }
    }

    function generateUVSphere(radius: number, numLat: int, numLong: int, tileLat: int, tileLong: int, firstClusterID: int): Mesh {
        const m = new Mesh();
        const r = f(radius);
        const tilesLat = Math.floor(numLat / tileLat);
        const tilesLong = Math.floor(numLong / tileLong);
        let clusterCounter = firstClusterID;
        for (let tLat = 0; tLat < tilesLat; tLat++) {
            for (let tLong = 0; tLong < tilesLong; tLong++) {
                const c = new Cluster();
                c.clusterID = clusterCounter++;
                c.gridU = tLat;
                c.gridV = tLong;
                c.matchedColorCid = c.clusterID;
                const latLo = tLat * tileLat;
                const longLo = tLong * tileLong;
                for (let li = 0; li <= tileLat; li++) {
                    for (let lj = 0; lj <= tileLong; lj++) {
                        const latIdx = latLo + li;
                        let longIdx = longLo + lj;
                        if (longIdx == numLong) {
                            longIdx = 0;
                        }
                        const theta = f(latIdx * Math.PI / numLat);
                        const phi = f(longIdx * 2.0 * Math.PI / numLong);
                        const sinT = fsin(theta);
                        const cosT = fcos(theta);
                        const cosP = fcos(phi);
                        const sinP = fsin(phi);
                        const nx = f(sinT * cosP);
                        const ny = cosT;
                        const nz = f(sinT * sinP);
                        c.positions.push(f(r * nx));
                        c.positions.push(f(r * ny));
                        c.positions.push(f(r * nz));
                        c.normals.push(nx);
                        c.normals.push(ny);
                        c.normals.push(nz);
                    }
                }
                gridTriangles(c, tileLat, tileLong);
                m.totalTriangles += tileLat * tileLong * 2;
                m.totalVertices += (tileLat + 1) * (tileLong + 1);
                m.clusters.push(c);
            }
        }
        return m;
    }

    function generateTorus(majorRadius: number, minorRadius: number, ringSegs: int, sideSegs: int,
        tileRing: int, tileSide: int, firstClusterID: int): Mesh {
        const m = new Mesh();
        const major = f(majorRadius);
        const minor = f(minorRadius);
        const tilesRing = Math.floor(ringSegs / tileRing);
        const tilesSide = Math.floor(sideSegs / tileSide);
        let clusterCounter = firstClusterID;
        for (let tR = 0; tR < tilesRing; tR++) {
            for (let tS = 0; tS < tilesSide; tS++) {
                const c = new Cluster();
                c.clusterID = clusterCounter++;
                c.gridU = tR;
                c.gridV = tS;
                c.matchedColorCid = c.clusterID;
                const rLo = tR * tileRing;
                const sLo = tS * tileSide;
                for (let ri = 0; ri <= tileRing; ri++) {
                    for (let si = 0; si <= tileSide; si++) {
                        let rIdx = rLo + ri;
                        let sIdx = sLo + si;
                        if (rIdx == ringSegs) {
                            rIdx = 0;
                        }
                        if (sIdx == sideSegs) {
                            sIdx = 0;
                        }
                        const u = f(rIdx * 2.0 * Math.PI / ringSegs);
                        const v = f(sIdx * 2.0 * Math.PI / sideSegs);
                        const cu = fcos(u);
                        const su = fsin(u);
                        const cv = fcos(v);
                        const sv = fsin(v);
                        const r = f(major + f(minor * cv));
                        c.positions.push(f(r * cu));
                        c.positions.push(f(minor * sv));
                        c.positions.push(f(r * su));
                        c.normals.push(f(cv * cu));
                        c.normals.push(sv);
                        c.normals.push(f(cv * su));
                    }
                }
                gridTriangles(c, tileRing, tileSide);
                m.totalTriangles += tileRing * tileSide * 2;
                m.totalVertices += (tileRing + 1) * (tileSide + 1);
                m.clusters.push(c);
            }
        }
        return m;
    }

    function generateCube(halfSize: number, faceSubdiv: int, tileSize: int, firstClusterID: int): Mesh {
        const m = new Mesh();
        const h = f(halfSize);
        // (origin, axisU, axisV) per face, axisU x axisV outward.
        const faces = [
            h, -h, -h, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0,
            -h, -h, -h, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0,
            -h, h, -h, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0,
            -h, -h, -h, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            -h, -h, h, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0,
            -h, -h, -h, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0,
        ];
        const tilesPerSide = Math.floor(faceSubdiv / tileSize);
        const du = f(f(2.0 * h) / faceSubdiv);
        let clusterCounter = firstClusterID;
        for (let face = 0; face < 6; face++) {
            const o = face * 9;
            const nx = f(f(faces[o + 4] * faces[o + 8]) - f(faces[o + 5] * faces[o + 7]));
            const ny = f(f(faces[o + 5] * faces[o + 6]) - f(faces[o + 3] * faces[o + 8]));
            const nz = f(f(faces[o + 3] * faces[o + 7]) - f(faces[o + 4] * faces[o + 6]));
            for (let tu = 0; tu < tilesPerSide; tu++) {
                for (let tv = 0; tv < tilesPerSide; tv++) {
                    const c = new Cluster();
                    c.clusterID = clusterCounter++;
                    c.gridU = tu;
                    c.gridV = tv;
                    c.matchedColorCid = c.clusterID;
                    for (let li = 0; li <= tileSize; li++) {
                        for (let lj = 0; lj <= tileSize; lj++) {
                            const u = f(du * (tu * tileSize + lj));
                            const v = f(du * (tv * tileSize + li));
                            for (let k = 0; k < 3; k++) {
                                c.positions.push(f(f(faces[o + k] + f(faces[o + 3 + k] * u)) + f(faces[o + 6 + k] * v)));
                            }
                            c.normals.push(nx);
                            c.normals.push(ny);
                            c.normals.push(nz);
                        }
                    }
                    gridTriangles(c, tileSize, tileSize);
                    m.totalTriangles += tileSize * tileSize * 2;
                    m.totalVertices += (tileSize + 1) * (tileSize + 1);
                    m.clusters.push(c);
                }
            }
        }
        return m;
    }

    // A flat XZ-plane of (tilesU x tilesV) cluster tiles, or with a thickness a closed slab: top,
    // bottom, and side walls split into a cluster per adjacent top tile (the tile's color and parity).
    function generatePlane(halfSizeU: number, halfSizeV: number, tilesU: int, tilesV: int, tileQuadsU: int, tileQuadsV: int,
        firstClusterID: int, thicknessValue: number): Mesh {
        const m = new Mesh();
        const thickness = f(thicknessValue);
        const slab = thickness > 0.0;
        const rowSize = tileQuadsV + 1;
        const makeAxis = (halfSize: number, quads: int): number[] => {
            const axis: number[] = [];
            for (let i = 0; i <= quads; i++) {
                axis.push(f(f(halfSize) * (2.0 * i / quads - 1.0)));
            }
            return axis;
        };
        const x = makeAxis(halfSizeU, tilesU * tileQuadsU);
        const z = makeAxis(halfSizeV, tilesV * tileQuadsV);
        let clusterCounter = firstClusterID;

        // The faces' quads: top (normal +Y) and bottom (-Y, reversed winding).
        for (let side = 0; side < (slab ? 2 : 1); side++) {
            for (let tu = 0; tu < tilesU; tu++) {
                for (let tv = 0; tv < tilesV; tv++) {
                    const c = new Cluster();
                    c.clusterID = clusterCounter++;
                    c.gridU = tu;
                    c.gridV = tv;
                    c.matchedColorCid = side == 0 ? c.clusterID : m.clusters[tu * tilesV + tv].clusterID;
                    if (slab) {
                        c.flags = c.flags | CLUSTER_FLAG_INTERIOR_SURFACE;
                    }
                    for (let li = 0; li <= tileQuadsU; li++) {
                        for (let lj = 0; lj <= tileQuadsV; lj++) {
                            c.positions.push(x[tu * tileQuadsU + li]);
                            c.positions.push(side == 0 ? 0.0 : -thickness);
                            c.positions.push(z[tv * tileQuadsV + lj]);
                            c.normals.push(0.0);
                            c.normals.push(side == 0 ? 1.0 : -1.0);
                            c.normals.push(0.0);
                        }
                    }
                    for (let li = 0; li < tileQuadsU; li++) {
                        for (let lj = 0; lj < tileQuadsV; lj++) {
                            const i00 = li * rowSize + lj;
                            const i01 = li * rowSize + lj + 1;
                            const i10 = (li + 1) * rowSize + lj;
                            const i11 = (li + 1) * rowSize + lj + 1;
                            if (side == 0) {
                                c.indices.push(i00);
                                c.indices.push(i01);
                                c.indices.push(i11);
                                c.indices.push(i00);
                                c.indices.push(i11);
                                c.indices.push(i10);
                            } else {
                                c.indices.push(i00);
                                c.indices.push(i11);
                                c.indices.push(i01);
                                c.indices.push(i00);
                                c.indices.push(i10);
                                c.indices.push(i11);
                            }
                        }
                    }
                    m.totalTriangles += tileQuadsU * tileQuadsV * 2;
                    m.totalVertices += (tileQuadsU + 1) * (tileQuadsV + 1);
                    m.clusters.push(c);
                }
            }
        }
        if (!slab) {
            return m;
        }

        // The side walls: -X, +X (slots along z), -Z, +Z (along x), near/far order reversed on +X and -Z
        // for the same index winding to face outward.
        const pushWallSlot = (alongZ: boolean, fixed: number, first: int, step: int, quads: int, nx: number, nz: number,
            gridU: int, gridV: int) => {
            const c = new Cluster();
            c.clusterID = clusterCounter++;
            c.gridU = gridU;
            c.gridV = gridV;
            c.matchedColorCid = firstClusterID + gridU * tilesV + gridV;
            c.flags = c.flags | CLUSTER_FLAG_INTERIOR_SURFACE;
            for (let i = 0; i <= quads; i++) {
                const index = first + step * i;
                const px = alongZ ? fixed : x[index];
                const pz = alongZ ? z[index] : fixed;
                for (let k = 0; k < 2; k++) {
                    c.positions.push(px);
                    c.positions.push(k == 0 ? 0.0 : -thickness);
                    c.positions.push(pz);
                    c.normals.push(nx);
                    c.normals.push(0.0);
                    c.normals.push(nz);
                }
            }
            for (let i = 0; i < quads; i++) {
                const a = 2 * i;
                const b = 2 * (i + 1);
                c.indices.push(a);
                c.indices.push(a + 1);
                c.indices.push(b + 1);
                c.indices.push(a);
                c.indices.push(b + 1);
                c.indices.push(b);
            }
            m.totalTriangles += 2 * quads;
            m.totalVertices += 2 * (quads + 1);
            m.clusters.push(c);
        };
        const xMin = x[0];
        const xMax = x[x.length - 1];
        const zMin = z[0];
        const zMax = z[z.length - 1];
        for (let tv = 0; tv < tilesV; tv++) {
            pushWallSlot(true, xMin, tv * tileQuadsV, 1, tileQuadsV, -1.0, 0.0, 0, tv);
        }
        for (let tv = 0; tv < tilesV; tv++) {
            pushWallSlot(true, xMax, (tv + 1) * tileQuadsV, -1, tileQuadsV, 1.0, 0.0, tilesU - 1, tv);
        }
        for (let tu = 0; tu < tilesU; tu++) {
            pushWallSlot(false, zMin, (tu + 1) * tileQuadsU, -1, tileQuadsU, 0.0, -1.0, tu, 0);
        }
        for (let tu = 0; tu < tilesU; tu++) {
            pushWallSlot(false, zMax, tu * tileQuadsU, 1, tileQuadsU, 0.0, 1.0, tu, tilesV - 1);
        }
        return m;
    }

    // The Klein bottle's "bottle with a handle" immersion: the body's and the handle's parametric
    // surfaces, blended by a smoothstep across u = pi.
    const K_PI = f(Math.PI);
    const K_VSCALE = 13.0;
    const K_THIN_DROP = 7.0;
    const K_BLEND_DELTA = f(K_PI / 16.0);

    function kleinPoint(u: number, v: number): number[] {
        const cu = fcos(u);
        const su = fsin(u);
        const r = f(4.0 * f(1.0 - f(cu * 0.5)));
        const halfCos = fcos(f(u * 0.5));
        const thinShift = f(f(-K_THIN_DROP * halfCos) * halfCos);
        const xBase = f(f(6.0 * cu) * f(1.0 + su));
        const y = f(r * fsin(v));
        const lower = f(K_PI - K_BLEND_DELTA);
        const upper = f(K_PI + K_BLEND_DELTA);
        // body: x = 6 cu (1 + su) + r cu cv, z = -13 su - r su cv + thinShift.
        const cv = fcos(v);
        const body = [
            f(xBase + f(f(r * cu) * cv)),
            y,
            f(f(f(-K_VSCALE * su) - f(f(r * su) * cv)) + thinShift),
        ];
        if (u <= lower) {
            return body;
        }
        // handle: x = 6 cu (1 + su) + r cos(v + pi), z = -13 su + thinShift.
        const handle = [
            f(xBase + f(r * fcos(f(v + K_PI)))),
            y,
            f(f(-K_VSCALE * su) + thinShift),
        ];
        if (u >= upper) {
            return handle;
        }
        const t = f(f(u - lower) / f(2.0 * K_BLEND_DELTA));
        const w = f(f(t * t) * f(3.0 - f(2.0 * t)));
        const result: number[] = [];
        for (let k = 0; k < 3; k++) {
            result.push(f(f(f(1.0 - w) * body[k]) + f(w * handle[k])));
        }
        return result;
    }

    function generateKleinBottle(bottleScale: number, numU: int, numV: int, tileUSize: int, tileVSize: int, firstClusterID: int): Mesh {
        const m = new Mesh();
        const tilesU = Math.floor(numU / tileUSize);
        const tilesV = Math.floor(numV / tileVSize);
        const invSpan = f(f(bottleScale) / K_VSCALE);
        const h = f(1e-3);
        let clusterCounter = firstClusterID;
        for (let tu = 0; tu < tilesU; tu++) {
            for (let tv = 0; tv < tilesV; tv++) {
                const c = new Cluster();
                c.clusterID = clusterCounter++;
                c.gridU = tu;
                c.gridV = tv;
                c.matchedColorCid = c.clusterID;
                for (let li = 0; li <= tileUSize; li++) {
                    for (let lj = 0; lj <= tileVSize; lj++) {
                        const gi = tu * tileUSize + li;
                        const gj = tv * tileVSize + lj;
                        const u = f(f(f(gi / numU) * 2.0) * K_PI);
                        const v = f(f(f(gj / numV) * 2.0) * K_PI);
                        const p = kleinPoint(u, v);
                        // Central-difference partials; normal = Pu x Pv.
                        const pu1 = kleinPoint(f(u + h), v);
                        const pu0 = kleinPoint(f(u - h), v);
                        const pv1 = kleinPoint(u, f(v + h));
                        const pv0 = kleinPoint(u, f(v - h));
                        const pu: number[] = [];
                        const pv: number[] = [];
                        for (let k = 0; k < 3; k++) {
                            pu.push(f(f(f(pu1[k] - pu0[k]) * 0.5) / h));
                            pv.push(f(f(f(pv1[k] - pv0[k]) * 0.5) / h));
                        }
                        let n = [
                            f(f(pu[1] * pv[2]) - f(pu[2] * pv[1])),
                            f(f(pu[2] * pv[0]) - f(pu[0] * pv[2])),
                            f(f(pu[0] * pv[1]) - f(pu[1] * pv[0])),
                        ];
                        let length = fsqrt(f(f(f(n[0] * n[0]) + f(n[1] * n[1])) + f(n[2] * n[2])));
                        if (length < f(1e-12)) {
                            n = [0.0, 1.0, 0.0];
                            length = 1.0;
                        }
                        n = [f(n[0] / length), f(n[1] / length), f(n[2] / length)];
                        // World X: the bottle's wide axis; Y: its height (z); Z: its depth (y).
                        c.positions.push(f(invSpan * p[0]));
                        c.positions.push(f(invSpan * p[2]));
                        c.positions.push(f(invSpan * p[1]));
                        c.normals.push(n[0]);
                        c.normals.push(n[2]);
                        c.normals.push(n[1]);
                    }
                }
                gridTriangles(c, tileUSize, tileVSize);
                m.totalTriangles += tileUSize * tileVSize * 2;
                m.totalVertices += (tileUSize + 1) * (tileVSize + 1);
                m.clusters.push(c);
            }
        }
        return m;
    }

    // ---- SceneData.cpp, MaterialData.cpp, SceneSetup.cpp ---------------------------------------

    // SceneCommon.h's CheckerOverride: <0 keeps the material's value.
    class CheckerOverride {
        overrideRefl: number = -1.0;
        overrideRefr: number = -1.0;
        overrideIor: number = -1.0;
        baseColorScale: number = 1.0;
    }

    // One object of the scene, a cluster BLAS in the TLAS.
    class SceneObject {
        mesh: Mesh = new Mesh();
        pos: number[] = [0.0, 0.0, 0.0];
        rotEuler: number[] = [0.0, 0.0, 0.0];
        scale: number = 1.0;
        // The material slot (a clone's: its random material override).
        instanceID: int = 0;
        checkerEnabled: boolean = false;
        evenParity: CheckerOverride = new CheckerOverride();
        oddParity: CheckerOverride = new CheckerOverride();
        surfTintMul: number = 1.0;
        refrTintMul: number = f(0.50);
        reflTintMul: number = f(1.08);
        nonOrientable: boolean = false;
        // Per material region (matRegionIdx): its material slot; empty for one region.
        perRegionMaterialSlot: int[] = [];
        globalClusterStart: int = 0;
        clusterCount: int = 0;

        checkerCouldRefract(): boolean {
            return this.checkerEnabled && (this.evenParity.overrideRefr > 0.0 || this.oddParity.overrideRefr > 0.0);
        }

        copy(): SceneObject {
            const o = new SceneObject();
            o.mesh = this.mesh.clone();
            o.pos = this.pos;
            o.rotEuler = this.rotEuler;
            o.scale = this.scale;
            o.instanceID = this.instanceID;
            o.checkerEnabled = this.checkerEnabled;
            o.evenParity = this.evenParity;
            o.oddParity = this.oddParity;
            o.surfTintMul = this.surfTintMul;
            o.refrTintMul = this.refrTintMul;
            o.reflTintMul = this.reflTintMul;
            o.nonOrientable = this.nonOrientable;
            o.perRegionMaterialSlot = this.perRegionMaterialSlot;
            return o;
        }
    }

    // MaterialData::kMaterials: baseColor.xyzw, reflectivity, refractivity, ior, translucency.
    const MATERIALS = [
        0.95, 0.95, 1.00, 0.0, 0.95, 0.0, 0.0, 0.0,
        0.92, 0.95, 1.00, 0.0, 0.10, 0.82, 1.55, 0.0,
        0.55, 0.95, 0.85, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.85, 0.65, 1.00, 0.0, 0.10, 0.78, 1.50, 0.0,
        0.95, 0.80, 0.55, 0.0, 0.10, 0.78, 1.50, 0.0,
        0.92, 0.78, 0.60, 0.0, 0.10, 0.82, 1.50, 0.0,
        0.85, 0.92, 0.95, 0.0, 0.06, 0.93, 1.50, 0.0,
        0.85, 0.90, 1.00, 0.0, 0.30, 0.78, 1.5, 0.0,
        0.85, 0.90, 1.00, 0.0, 0.08, 0.78, 1.5, 0.0,
    ];

    function materialRefractivity(slot: int): number {
        return f(MATERIALS[slot * 8 + 5]);
    }

    function materialTranslucency(slot: int): number {
        return f(MATERIALS[slot * 8 + 7]);
    }

    // Whether an object of this material and checker ever refracts or is translucent (the glass hit group).
    function needsGlass(slot: int, obj: SceneObject): boolean {
        return materialRefractivity(slot) > 0.0 || materialTranslucency(slot) > 0.0 || obj.checkerCouldRefract();
    }

    // SceneData::BuildSceneDefinition and BuildScene: four spheres and a torus and a cube on a hexagon
    // around the origin, the glass slab floor, the Klein bottle; the smallest sphere split into a chrome
    // upper and a glass lower region.
    function buildSceneObjects(): SceneObject[] {
        const R = f(2.55);
        const hexStep = f(f(2.0 * K_PI) / 6.0);
        const hex = (i: int, y: number): number[] => {
            const th = f(i * hexStep);
            return [f(R * fcos(th)), f(y), f(R * fsin(th))];
        };
        const objects: SceneObject[] = [];
        const add = (mesh: Mesh, pos: number[], instanceID: int): SceneObject => {
            const o = new SceneObject();
            o.mesh = mesh;
            o.pos = pos;
            o.instanceID = instanceID;
            objects.push(o);
            return o;
        };

        add(generateUVSphere(0.85, 64, 128, 8, 16, 0), hex(0, 0.40), 0);
        const s1 = add(generateUVSphere(0.60, 48, 96, 8, 12, 100), hex(1, 0.4), 1);
        s1.checkerEnabled = true;
        s1.oddParity.overrideRefl = f(0.90);
        s1.oddParity.overrideRefr = 0.0;
        s1.oddParity.overrideIor = 0.0;
        const s2 = add(generateUVSphere(0.55, 32, 64, 8, 8, 200), hex(2, -0.1), 2);
        s2.checkerEnabled = true;
        s2.oddParity.overrideRefr = f(0.85);
        s2.oddParity.overrideIor = f(1.50);
        s2.evenParity.baseColorScale = f(1.45);
        add(generateUVSphere(0.45, 24, 48, 6, 8, 300), hex(3, 0.3), 3);
        const torus = add(generateTorus(0.55, 0.18, 64, 32, 8, 8, 400), hex(4, 0.2), 4);
        torus.rotEuler = [f(1.0472), 0.0, 0.0];
        add(generateCube(0.45, 1, 1, 500), hex(5, 0.0), 5);
        const floor = add(generatePlane(3.5, 3.5, 6, 6, 1, 1, 600, 0.28), [0.0, f(-0.7), 0.0], 6);
        floor.surfTintMul = f(0.25);
        floor.refrTintMul = f(0.35);
        floor.reflTintMul = f(0.31);
        floor.checkerEnabled = true;
        floor.oddParity.overrideRefl = f(0.85);
        floor.oddParity.overrideRefr = 0.0;
        floor.oddParity.overrideIor = 0.0;
        const klein = add(generateKleinBottle(0.65, 64, 32, 8, 8, 700), [f(-1.55), f(1.55), f(-1.00)], 8);
        klein.rotEuler = [f(0.90), f(0.55), f(-0.55)];
        klein.nonOrientable = true;

        // The mixed sphere (sphere3): clusters whose centroid is above the equator chrome (region 0,
        // material 0), the others its amethyst glass (region 1, material 3).
        for (const obj of objects) {
            if (obj.instanceID != 3) {
                continue;
            }
            for (const c of obj.mesh.clusters) {
                let centroidY = 0.0;
                for (let v = 1; v < c.positions.length; v += 3) {
                    centroidY = f(centroidY + c.positions[v]);
                }
                centroidY = f(centroidY / c.vertexCount());
                c.matRegionIdx = centroidY >= 0.0 ? 0 : 1;
            }
            obj.perRegionMaterialSlot = [0, 3];
        }
        return objects;
    }

    // ---- ScenePopulation.cpp: the clones -------------------------------------------------------

    // An animated clone: the animated sphere's CLASes, in a BLAS of its own at its place.
    class AnimatedClone {
        pos: number[] = [0.0, 0.0, 0.0];
        rotEuler: number[] = [0.0, 0.0, 0.0];
        scale: number = 1.0;
    }

    // uint32 arithmetic in doubles (exact): the clones' seed hash.
    function u32Mul(a: number, b: number): number {
        const aLo = a % 65536;
        const aHi = Math.floor(a / 65536);
        const bLo = b % 65536;
        const bHi = Math.floor(b / 65536);
        const cross = (aHi * bLo + aLo * bHi) % 65536;
        return (cross * 65536 + aLo * bLo) % 4294967296;
    }

    function u32Xor(a: number, b: number): number {
        const aLo: int = a % 65536;
        const aHi: int = Math.floor(a / 65536);
        const bLo: int = b % 65536;
        const bHi: int = Math.floor(b / 65536);
        // The xors in ints (16 bits each), the combining in doubles (an int product would overflow).
        const hi: number = aHi ^ bHi;
        const lo: number = aLo ^ bLo;
        return hi * 65536.0 + lo;
    }

    // The clone's seed: a Wang-style mix of its index and 0xC10E5EED, as int bits.
    function cloneSeedBits(i: int): int {
        // 0xC10E5EED and 0x119DE1F3 as doubles (not int literals).
        let mixed = (i + 3238944493.0) % 4294967296.0;
        mixed = u32Mul(u32Xor(Math.floor(mixed / 65536.0), mixed), 295559667.0);
        mixed = u32Mul(u32Xor(Math.floor(mixed / 65536.0), mixed), 295559667.0);
        mixed = u32Xor(Math.floor(mixed / 65536.0), mixed);
        const bits: int = mixed >= 2147483648.0 ? mixed - 4294967296.0 : mixed;
        return bits;
    }

    // std::uniform_real_distribution<float>(a, b) as the sample's toolset (v143, MSVC 14.44) compiles
    // it: its generate_canonical comes out as float(g()) * 2^-32 (the engine's 32 bits rounded to a
    // float), where MSVC 14.51 (this repository's) truncates g() >> 8 - a few ulps apart at times. The
    // engine's raw numbers are uniform_int_distribution<unsigned>'s over the whole range.
    function uniformFloat(rng: RandomEngine, a: number, b: number): number {
        const bits = rng.uniformUInt(0, -1);
        const g = bits < 0 ? bits + 4294967296.0 : bits;
        const canonical = f(f(g) * f(1.0 / 4294967296.0));
        return f(f(canonical * f(f(b) - f(a))) + f(a));
    }

    // EnsureCloneSourceLodMeshes: lower-tessellation chains for sphere0 (instance 0), the torus (4) and
    // the Klein bottle (8), halving the grid per level with the tiles' size kept.
    class LodChains {
        sphere: Mesh[] = [];
        torus: Mesh[] = [];
        klein: Mesh[] = [];

        constructor() {
            for (let lod = 0; lod < 4; lod++) {
                const nLat = 64 >> lod;
                const nLong = 128 >> lod;
                if (nLat >= 8 && nLong >= 16) {
                    this.sphere.push(generateUVSphere(0.85, nLat, nLong, 8, 16, 0));
                }
                const nRing = 64 >> lod;
                const nSide = 32 >> lod;
                if (nRing >= 8 && nSide >= 8) {
                    this.torus.push(generateTorus(0.55, 0.18, nRing, nSide, 8, 8, 0));
                    this.klein.push(generateKleinBottle(0.65, nRing, nSide, 8, 8, 0));
                }
            }
        }

        forInstance(instanceID: int): Mesh[] {
            return instanceID == 0 ? this.sphere : instanceID == 4 ? this.torus : instanceID == 8 ? this.klein : [];
        }
    }

    // RegenerateWorkloadCloneInstances: count clones on a constant-density golden-angle spiral outside
    // the floor, rising with their radius, each with its own std::mt19937 (seeded from its index): a
    // random rotation, scale and material; cycling sphere0, the torus, the cube, the Klein bottle and
    // the animated sphere; static ones farther out on lower levels of detail.
    function addClones(app: App, objects: SceneObject[], animatedClones: AnimatedClone[], count: int) {
        if (count == 0) {
            return;
        }
        const sourceCount = objects.length;
        const sources: int[] = [];
        for (const keep of [0, 4, 5, 8]) {
            for (let i = 0; i < sourceCount; i++) {
                if (objects[i].instanceID == keep) {
                    sources.push(i);
                    break;
                }
            }
        }
        const poolSize = sources.length + 1;
        const animatedSlot = sources.length;
        const innerRadius = f(5.5);
        const radialSpacing = 1.0;
        const jitterFrac = f(0.15);
        const innerY = -1.0;
        const heightSqrtMul = 0.5;
        const heightLinearMul = f(0.15);
        const goldenAngle = f(2.39996323);
        const lodFullDetailFrac = 0.25;
        const maxRadius = f(innerRadius + f(fsqrt(count) * radialSpacing));
        const lodRadialSpan = fmax(f(0.001), f(maxRadius - innerRadius));
        const lods = new LodChains();
        const rotMax = f(6.2831853);
        const scaleMin = f(0.40);
        const scaleMax = f(0.70);

        for (let i = 0; i < count; i++) {
            const cycleSlot = i % poolSize;
            const rng = app.createRandomEngineFromBits(cloneSeedBits(i));
            const angleJitter = f(f(uniformFloat(rng, -0.5, 0.5) * goldenAngle) * jitterFrac);
            const radiusJitter = f(f(uniformFloat(rng, -0.5, 0.5) * radialSpacing) * jitterFrac);
            const angle = f(f(i * goldenAngle) + angleJitter);
            const radiusBase = fsqrt(f(f(innerRadius * innerRadius) + f(f(i * radialSpacing) * radialSpacing)));
            const radius = fmax(innerRadius, f(radiusBase + radiusJitter));
            const rOff = fmax(0.0, f(radius - innerRadius));
            const heightY = f(f(innerY + f(fsqrt(rOff) * heightSqrtMul)) + f(rOff * heightLinearMul));
            const spiralPos = [f(radius * fcos(angle)), heightY, f(radius * fsin(angle))];
            const rx = uniformFloat(rng, 0.0, rotMax);
            const ry = uniformFloat(rng, 0.0, rotMax);
            const rz = uniformFloat(rng, 0.0, rotMax);
            const randScale = uniformFloat(rng, scaleMin, scaleMax);
            const randMatSlot = rng.uniformUInt(0, MATERIAL_SLOTS - 1);

            if (cycleSlot == animatedSlot) {
                const ac = new AnimatedClone();
                ac.pos = spiralPos;
                ac.rotEuler = [rx, ry, rz];
                ac.scale = randScale;
                animatedClones.push(ac);
                continue;
            }
            const source = objects[sources[cycleSlot]];
            const clone = source.copy();
            const chain = lods.forInstance(source.instanceID);
            if (chain.length > 0) {
                const tRaw = fmin(fmax(f(f(radius - innerRadius) / lodRadialSpan), 0.0), 1.0);
                const tEff = tRaw <= lodFullDetailFrac ? 0.0 : f(f(tRaw - lodFullDetailFrac) / f(1.0 - lodFullDetailFrac));
                let lodLevel = Math.floor(f(tEff * chain.length));
                if (lodLevel >= chain.length) {
                    lodLevel = chain.length - 1;
                }
                if (lodLevel > 0) {
                    clone.mesh = chain[lodLevel].clone();
                }
            }
            clone.pos = spiralPos;
            clone.rotEuler = [rx, ry, rz];
            clone.scale = randScale;
            clone.instanceID = randMatSlot;
            objects.push(clone);
        }
    }

    // ---- The scene on the CPU --------------------------------------------------------------------

    class Settings {
        extraInstances: int = 100;
        wireframe: boolean = false;
        cameraPaused: boolean = false;
        animationPaused: boolean = false;
        // -dumpScene <dir>: the scene's tables (as the reference's dump hooks), for comparing.
        dumpScenePath: string = "";
    }

    // The objects (the sources, then the static clones), the animated sphere and its clones, their
    // cluster IDs (the sources' as authored, each clone's a range after them, the animated sphere's
    // after those), and the tables the hit shaders read.
    class Scene {
        objects: SceneObject[] = [];
        sourceCount: int = 0;
        animated: Mesh = new Mesh();
        animatedClones: AnimatedClone[] = [];
        animatedPos: number[] = [0.0, f(1.10), 0.0];
        animatedInstanceID: int = 7;
        animatedClusterIdOffset: int = 0;
        totalClusterCount: int = 0;

        build(app: App, extraInstances: int) {
            this.objects = buildSceneObjects();
            this.sourceCount = this.objects.length;
            addClones(app, this.objects, this.animatedClones, extraInstances);
            // BuildAnimatedObjectSetup: a unit sphere of 96 x 192 quads in 4 x 6 tiles.
            this.animated = generateUVSphere(ANIMATED_REST_RADIUS, 96, 192, 4, 6, 0);

            // finalizeClusterIdsAndCounts.
            let nextClusterId = 0;
            for (let oi = 0; oi < this.sourceCount; oi++) {
                for (const c of this.objects[oi].mesh.clusters) {
                    if (c.clusterID + 1 > nextClusterId) {
                        nextClusterId = c.clusterID + 1;
                    }
                }
            }
            let runningOffset = 0;
            for (let oi = 0; oi < this.objects.length; oi++) {
                const obj = this.objects[oi];
                obj.globalClusterStart = runningOffset;
                obj.clusterCount = obj.mesh.clusters.length;
                if (oi >= this.sourceCount && obj.clusterCount > 0) {
                    const localFirst = obj.mesh.clusters[0].clusterID;
                    let localMax = localFirst;
                    for (const c of obj.mesh.clusters) {
                        if (c.clusterID > localMax) {
                            localMax = c.clusterID;
                        }
                    }
                    for (const c of obj.mesh.clusters) {
                        c.clusterID = nextClusterId + (c.clusterID - localFirst);
                        c.matchedColorCid = nextClusterId + (c.matchedColorCid - localFirst);
                    }
                    nextClusterId += localMax - localFirst + 1;
                }
                runningOffset += obj.clusterCount;
            }
            this.totalClusterCount = runningOffset;
            this.animatedClusterIdOffset = nextClusterId;
        }

        maxClusterID(): int {
            let maxId = 0;
            for (const obj of this.objects) {
                for (const c of obj.mesh.clusters) {
                    if (c.clusterID > maxId) {
                        maxId = c.clusterID;
                    }
                }
            }
            for (const c of this.animated.clusters) {
                if (c.clusterID + this.animatedClusterIdOffset > maxId) {
                    maxId = c.clusterID + this.animatedClusterIdOffset;
                }
            }
            return maxId;
        }

        // A cluster's material: its region's, else its object's.
        clusterMaterial(obj: SceneObject, c: Cluster): int {
            return c.matRegionIdx < obj.perRegionMaterialSlot.length ? obj.perRegionMaterialSlot[c.matRegionIdx] : obj.instanceID;
        }

        // BuildClusterMetadata: a ClusterMeta per cluster ID (colorIndex, flags, the checker parity's
        // overrides, the tint multipliers, the material slot, the reflection scale).
        clusterMeta(): f32[] {
            const count = this.maxClusterID() + 1;
            const meta = zeros(count * CLUSTER_META_SIZE / 4);
            for (let i = 0; i < count; i++) {
                const m = i * CLUSTER_META_SIZE / 4;
                storeUint(meta, m, i);
                meta[m + 2] = -1.0;
                meta[m + 3] = -1.0;
                meta[m + 4] = -1.0;
                meta[m + 5] = 1.0;
                meta[m + 6] = 1.0;
                meta[m + 7] = 0.50;
                meta[m + 8] = 1.08;
                meta[m + 10] = 1.0;
            }
            for (const obj of this.objects) {
                this.fillMeta(meta, obj.mesh, 0, obj.checkerEnabled, obj.evenParity, obj.oddParity, obj.surfTintMul,
                    obj.refrTintMul, obj.reflTintMul, obj, obj.instanceID);
            }
            // The animated sphere: even clusters opaque chrome-like, odd ones its glass (no reflection).
            const even = new CheckerOverride();
            even.overrideRefl = f(0.95);
            even.overrideRefr = 0.0;
            const odd = new CheckerOverride();
            odd.overrideRefl = 0.0;
            this.fillMeta(meta, this.animated, this.animatedClusterIdOffset, true, even, odd, 1.0, f(0.75), f(1.20), null,
                this.animatedInstanceID);
            for (const c of this.animated.clusters) {
                const m = (c.clusterID + this.animatedClusterIdOffset) * CLUSTER_META_SIZE / 4;
                storeUint(meta, m + 1, c.flags | CLUSTER_META_FLAG_ANIMATED_SPHERE);
                meta[m + 10] = 0.5;
            }
            return meta;
        }

        private fillMeta(meta: f32[], mesh: Mesh, cidOffset: int, checkerEnabled: boolean, even: CheckerOverride,
            odd: CheckerOverride, surf: number, refr: number, refl: number, obj: SceneObject | null, defaultSlot: int) {
            for (const c of mesh.clusters) {
                const m = (c.clusterID + cidOffset) * CLUSTER_META_SIZE / 4;
                storeUint(meta, m, c.matchedColorCid + cidOffset);
                storeUint(meta, m + 1, c.flags);
                meta[m + 6] = surf;
                meta[m + 7] = refr;
                meta[m + 8] = refl;
                let slot = defaultSlot;
                if (obj) {
                    slot = this.clusterMaterial(obj, c);
                }
                storeUint(meta, m + 9, slot);
                if (checkerEnabled) {
                    const side = ((c.gridU + c.gridV) & 1) != 0 ? odd : even;
                    meta[m + 2] = side.overrideRefl;
                    meta[m + 3] = side.overrideRefr;
                    meta[m + 4] = side.overrideIor;
                    meta[m + 5] = side.baseColorScale;
                }
            }
        }

        // BuildClusterShaderSideBuffers: every cluster's normals (float3 in 16 bytes), its indices widened
        // to uints, and per cluster ID the offsets of its first normal and index.
        sideBuffers(normals: f32[], indices: int[], offsets: int[]) {
            const count = this.maxClusterID() + 1;
            for (let i = 0; i < count * 2; i++) {
                offsets.push(0);
            }
            for (const obj of this.objects) {
                for (const c of obj.mesh.clusters) {
                    appendSideData(c, c.clusterID, normals, indices, offsets);
                }
            }
            for (const c of this.animated.clusters) {
                appendSideData(c, c.clusterID + this.animatedClusterIdOffset, normals, indices, offsets);
            }
        }

        instanceCount(): int {
            return this.objects.length + 1 + this.animatedClones.length;
        }

        // BuildPerInstGeomMaterialTable: per instance and geometry index (material region) the material slot.
        perInstanceGeometryMaterials(): int[] {
            const table: int[] = [];
            for (let i = 0; i < this.instanceCount() * MAX_GEOMS_PER_INSTANCE; i++) {
                table.push(0);
            }
            for (let oi = 0; oi < this.objects.length; oi++) {
                const obj = this.objects[oi];
                let regionCount = obj.perRegionMaterialSlot.length;
                if (regionCount == 0) {
                    for (const c of obj.mesh.clusters) {
                        if (c.matRegionIdx + 1 > regionCount) {
                            regionCount = c.matRegionIdx + 1;
                        }
                    }
                    if (regionCount == 0) {
                        regionCount = 1;
                    }
                }
                for (let r = 0; r < regionCount && r < MAX_GEOMS_PER_INSTANCE; r++) {
                    table[oi * MAX_GEOMS_PER_INSTANCE + r] = r < obj.perRegionMaterialSlot.length ? obj.perRegionMaterialSlot[r] : obj.instanceID;
                }
            }
            for (let k = 0; k <= this.animatedClones.length; k++) {
                table[(this.objects.length + k) * MAX_GEOMS_PER_INSTANCE] = this.animatedInstanceID;
            }
            return table;
        }

        // The per-instance material overrides: the static clones' random materials, none elsewhere.
        materialOverrides(): int[] {
            const overrides: int[] = [];
            for (let i = 0; i < this.instanceCount(); i++) {
                overrides.push(i >= this.sourceCount && i < this.objects.length ? this.objects[i].instanceID : -1);
            }
            return overrides;
        }

        // BuildTlasClassic: scale, then roll / pitch / yaw, then translation; InstanceID the material
        // slot; the hit group block (opaque, glass, or mixed per region) and FORCE_OPAQUE unless glass;
        // the Klein bottle double-sided. blasAddresses: per instance its BLAS's address (lo, hi).
        instances(blasAddresses: int[]): f32[] {
            const data = zeros(this.instanceCount() * INSTANCE_SIZE / 4);
            for (let i = 0; i < this.objects.length; i++) {
                const obj = this.objects[i];
                const firstSlot = obj.perRegionMaterialSlot.length == 0 ? obj.instanceID : obj.perRegionMaterialSlot[0];
                let glassRegions = needsGlass(firstSlot, obj) ? 1 : 0;
                for (let r = 1; r < obj.perRegionMaterialSlot.length; r++) {
                    if (needsGlass(obj.perRegionMaterialSlot[r], obj)) {
                        glassRegions++;
                    }
                }
                const regions = obj.perRegionMaterialSlot.length > 1 ? obj.perRegionMaterialSlot.length : 1;
                const mixed = glassRegions > 0 && glassRegions < regions;
                const glass = glassRegions > 0;
                let flags = glass ? 0 : INSTANCE_FLAG_FORCE_OPAQUE;
                if (obj.nonOrientable) {
                    flags = flags | INSTANCE_FLAG_TRIANGLE_CULL_DISABLE;
                }
                storeInstance(data, i, obj.scale, obj.rotEuler, true, obj.pos, obj.instanceID,
                    mixed ? HIT_GROUP_MIXED : glass ? HIT_GROUP_GLASS : HIT_GROUP_OPAQUE, flags, blasAddresses);
            }
            // The animated sphere and its clones: its glass material.
            const slot = this.animatedInstanceID;
            const glass = materialRefractivity(slot) > 0.0 || materialTranslucency(slot) > 0.0;
            const contribution = glass ? HIT_GROUP_GLASS : HIT_GROUP_OPAQUE;
            const flags = glass ? 0 : INSTANCE_FLAG_FORCE_OPAQUE;
            storeInstance(data, this.objects.length, 1.0, [0.0, 0.0, 0.0], false, this.animatedPos, slot, contribution,
                flags, blasAddresses);
            for (let k = 0; k < this.animatedClones.length; k++) {
                const ac = this.animatedClones[k];
                storeInstance(data, this.objects.length + 1 + k, ac.scale, ac.rotEuler, true, ac.pos, slot, contribution,
                    flags, blasAddresses);
            }
            return data;
        }
    }

    function appendSideData(c: Cluster, cid: int, normals: f32[], indices: int[], offsets: int[]) {
        offsets[cid * 2] = normals.length / 4;
        offsets[cid * 2 + 1] = indices.length;
        for (let v = 0; v < c.normals.length; v += 3) {
            normals.push(c.normals[v]);
            normals.push(c.normals[v + 1]);
            normals.push(c.normals[v + 2]);
            normals.push(0.0);
        }
        for (const index of c.indices) {
            indices.push(index);
        }
    }

    // A D3D12_RAYTRACING_INSTANCE_DESC: XMStoreFloat3x4 of scale x rotation x translation (the transpose's
    // first three rows), InstanceID and mask, hit group contribution and flags, the BLAS's address.
    function storeInstance(data: f32[], row: int, scale: number, rot: number[], rotated: boolean, pos: number[],
        instanceID: int, contribution: int, flags: int, blasAddresses: int[]) {
        let m = matrixScaling(scale, scale, scale);
        if (rotated) {
            m = matrixMultiply(m, matrixRotationRollPitchYaw(rot[0], rot[1], rot[2]));
        }
        m = matrixMultiply(m, matrixTranslation(pos[0], pos[1], pos[2]));
        const o = row * INSTANCE_SIZE / 4;
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 4; c++) {
                data[o + r * 4 + c] = m[c * 4 + r];
            }
        }
        storeUint(data, o + 12, (instanceID & 0xFFFFFF) | (0xFF << 24));
        storeUint(data, o + 13, (contribution & 0xFFFFFF) | (flags << 24));
        storeUint(data, o + 14, blasAddresses[row * 2]);
        storeUint(data, o + 15, blasAddresses[row * 2 + 1]);
    }

    // UpdateSceneConstantBuffer: the camera orbiting the scene (a turn in 30 s, swinging in from 6.5 to
    // 3.5 and back every 19 s), looking at (0.5, 0, 0) from 1.5 up with a 60 degree vertical field of
    // view; the sun; the bounce limits; the clustered path; wireframe.
    function sceneConstants(width: int, height: int, cameraSeconds: number, animationSeconds: number, wireframe: boolean): f32[] {
        const data = zeros(SCENE_CONSTANTS_SIZE / 4);
        const angle = f(cameraSeconds * (2.0 * Math.PI / 30.0));
        const dollyPhase = f(cameraSeconds * (2.0 * Math.PI / 19.0));
        const radius = f(6.5 - f(f(3.0 * 0.5) * f(1.0 - fcos(dollyPhase))));
        const eye = [f(radius * fsin(angle)), 1.5, f(-radius * fcos(angle)), 1.0];
        const view = matrixLookAtLH(eye, [0.5, 0.0, 0.0, 1.0], [0.0, 1.0, 0.0, 0.0]);
        // XMMATRIX's rows as they are (the shader's column-major cbuffer sees the transpose).
        const viewToWorld = matrixInverse(view);
        for (let i = 0; i < 16; i++) {
            data[i] = viewToWorld[i];
        }
        for (let i = 0; i < 4; i++) {
            data[16 + i] = eye[i];
        }
        data[20] = f(width / height);
        data[21] = Donut_Tanf(f(f(60.0 * f(XM_PI / 180.0)) * 0.5));
        data[22] = 1.0;
        data[23] = f(CLUSTER_TINT);
        const sun = normalize3([f(0.45), f(0.75), f(0.50), 0.0]);
        data[24] = sun[0];
        data[25] = sun[1];
        data[26] = sun[2];
        data[27] = f(0.40);
        data[28] = f(animationSeconds);
        storeUint(data, 32, REFLECTION_BOUNCES);
        storeUint(data, 33, REFRACTION_BOUNCES);
        storeUint(data, 34, 0);
        storeUint(data, 35, wireframe ? 1 : 0);
        return data;
    }

    // ---- The GPU side ----------------------------------------------------------------------------

    // core/clas.cpp's operation description.
    function clasParams(type: int, mode: int, flags: int, maxArgCount: int): int[] {
        const params: int[] = [];
        for (let i = 0; i < CLAS_PARAM_COUNT; i++) {
            params.push(0);
        }
        params[0] = type;
        params[1] = mode;
        params[2] = flags;
        params[3] = maxArgCount;
        params[5] = 1;
        return params;
    }

    function setClusterLimits(params: int[], maxGeometryIndex: int, maxTriangles: int, maxVertices: int,
        totalTriangles: int, totalVertices: int) {
        params[4] = maxGeometryIndex;
        params[6] = maxTriangles;
        params[7] = maxVertices;
        params[8] = totalTriangles;
        params[9] = totalVertices;
    }

    class ComputePass {
        layout: BindingLayoutHandle;
        pipeline: ComputePipelineHandle;
        pushConstantBytes: int;

        constructor(layout: BindingLayoutHandle, pipeline: ComputePipelineHandle, pushConstantBytes: int) {
            this.layout = layout;
            this.pipeline = pipeline;
            this.pushConstantBytes = pushConstantBytes;
        }
    }

    class ClusteredGeometryPass {
        private app: App;
        private clas: Clas;
        private scene: Scene;
        private settings: Settings;

        private fillClasArgs: ComputePass | null = null;
        private fillBlasArgs: ComputePass | null = null;
        private fillTemplateArgs: ComputePass | null = null;
        private fillInstantiateArgs: ComputePass | null = null;
        private animateBall: ComputePass | null = null;
        private animateSet: BindingSet = new BindingSet(null);

        // The static objects' cluster BLASes: one pool, an offset per object.
        private staticBlasPool: BufferHandle | null = null;
        private staticBlasOffsets: number[] = [];
        // The animated sphere's per-frame resources: its deformed vertices, instantiation arguments,
        // CLASes, and BLASes (its own first, then its clones') in one pool.
        private restPositions: BufferHandle | null = null;
        private animatedVertices: BufferHandle | null = null;
        private instantiateArgs: BufferHandle | null = null;
        private templateStorage: BufferHandle | null = null;
        private animatedClasStorage: BufferHandle | null = null;
        private animatedClasScratch: BufferHandle | null = null;
        private animatedClasAddresses: BufferHandle | null = null;
        private animatedBlasArgs: BufferHandle | null = null;
        private animatedBlasDestinations: BufferHandle | null = null;
        private animatedBlasPool: BufferHandle | null = null;
        private animatedBlasScratch: BufferHandle | null = null;
        private animatedBlasSize: number = 0.0;
        private instantiateParams: int[] = [];
        private animatedBlasParams: int[] = [];

        private tlas: AccelStructHandle | null = null;
        private tlasInstances: BufferHandle | null = null;
        private sceneConstantBuffer: BufferHandle | null = null;
        private rayTracingLayout: BindingLayoutHandle | null = null;
        private shaderTable: ShaderTable = new ShaderTable(null);
        private wireframeTable: ShaderTable = new ShaderTable(null);
        private rayTracingSet: BindingSet = new BindingSet(null);
        private output: TextureHandle | null = null;
        // t1..t9: the materials, normals, indices, offsets, cluster metadata, the traditional path's
        // two tables, the per-instance geometry materials, the material overrides.
        private shaderBuffers: BufferHandle[] = [];

        private cameraSeconds: number = 0.0;
        private animationSeconds: number = 0.0;
        private sceneData: f32[] = [];
        private animateData: f32[] = [0.0, 0.0];

        constructor(app: App, clas: Clas, scene: Scene, settings: Settings) {
            this.app = app;
            this.clas = clas;
            this.scene = scene;
            this.settings = settings;
        }

        init() {
            if (!this.createComputePasses() || !this.createRayTracingPipeline()) {
                return false;
            }
            const commandList = this.app.createCommandList();
            commandList.open();
            this.buildStatic(commandList);
            this.buildAnimatedSetup(commandList);
            this.uploadTables(commandList);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);

            const pass = this.app.addPass();
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            pass.setKeyboardCallback(this.onKey);
            return true;
        }

        private createComputePass(file: string, pushConstantBytes: int, srvCount: int, uavCount: int): ComputePass | null {
            const layoutDesc = BindingLayoutDesc.create();
            for (let t = 0; t < srvCount; t++) {
                layoutDesc.layoutRawBufferSRV(t);
            }
            for (let u = 0; u < uavCount; u++) {
                layoutDesc.layoutRawBufferUAV(u);
            }
            layoutDesc.layoutPushConstants(0, pushConstantBytes);
            const layout = this.app.createBindingLayout(layoutDesc, ShaderType.Compute);
            const shader = this.app.createShader(`clustered_geometry/${file}`, "main", ShaderType.Compute);
            if (!shader) {
                return null;
            }
            const pipeline = this.app.createComputePipelineWithLayout(shader, layout);
            this.app.releaseResource(shader);
            return new ComputePass(layout, pipeline, pushConstantBytes);
        }

        private createComputePasses() {
            this.fillClasArgs = this.createComputePass("FillClasFromTrianglesArgs.hlsl", 20, 1, 1);
            this.fillBlasArgs = this.createComputePass("FillBlasFromClasArgs.hlsl", 8, 1, 1);
            this.fillTemplateArgs = this.createComputePass("FillClusterTemplateArgs.hlsl", 24, 1, 1);
            this.fillInstantiateArgs = this.createComputePass("FillInstantiateArgs.hlsl", 20, 1, 2);
            this.animateBall = this.createComputePass("AnimateBall.hlsl", 8, 1, 1);
            return this.fillClasArgs != null && this.fillBlasArgs != null && this.fillTemplateArgs != null
                && this.fillInstantiateArgs != null && this.animateBall != null;
        }

        // A dispatch of a pass over count threads: t0.., u0.., the push constants.
        private dispatch(commandList: CommandList, pass: ComputePass | null, srvs: BufferHandle[], uavs: BufferHandle[],
            constants: int[], count: int) {
            if (!pass) {
                return;
            }
            const desc = BindingSetDesc.create();
            for (let t = 0; t < srvs.length; t++) {
                desc.bindRawBufferSRV(t, srvs[t]);
            }
            for (let u = 0; u < uavs.length; u++) {
                desc.bindRawBufferUAV(u, uavs[u]);
            }
            desc.bindPushConstants(0, pass.pushConstantBytes);
            const set = this.app.createBindingSetForLayout(desc, pass.layout);
            commandList.dispatchWithPushConstants(pass.pipeline, set, Ref(constants[0]), pass.pushConstantBytes,
                Math.floor((count + GROUP_SIZE - 1) / GROUP_SIZE), 1, 1);
            // The command list holds it until the GPU is done with it.
            this.app.releaseResource(set.handle);
        }

        private address(buffer: BufferHandle, offset: number): int[] {
            const result = [0, 0];
            this.clas.getBufferAddress(buffer, offset, Ref(result[0]));
            return result;
        }

        private operationSizes(params: int[]): number[] {
            const sizes = [0.0, 0.0];
            this.clas.getOperationSizes(Ref(params[0]), Ref(sizes[0]));
            return sizes;
        }

        // UploadClusterInputs, BuildClas (implicit destinations) and BuildBlasFromClasIndirect: every
        // static cluster's vertices and indices in one buffer, the CLAS arguments the fill shader writes,
        // the CLASes; per object the cluster BLAS of its CLASes in one pool, at addresses the TLAS gets.
        private buildStatic(commandList: CommandList) {
            const scene = this.scene;
            const clas = this.clas;
            const clusterCount = scene.totalClusterCount;
            const offsets: int[] = [];
            let cursor = 0;
            let maxTriangles = 0;
            let maxVertices = 0;
            let totalTriangles = 0;
            let totalVertices = 0;
            for (const obj of scene.objects) {
                for (const c of obj.mesh.clusters) {
                    cursor = alignUp(cursor, 16);
                    offsets.push(cursor);
                    cursor += c.vertexCount() * 12;
                    cursor = alignUp(cursor, 16);
                    offsets.push(cursor);
                    cursor += c.indices.length;
                    if (c.triangleCount() > maxTriangles) {
                        maxTriangles = c.triangleCount();
                    }
                    if (c.vertexCount() > maxVertices) {
                        maxVertices = c.vertexCount();
                    }
                    totalTriangles += c.triangleCount();
                    totalVertices += c.vertexCount();
                }
            }
            const inputSize = alignUp(cursor, 256);
            const input = zeros(inputSize / 4);
            const argsMeta = zeros(clusterCount * CLAS_ARGS_META_SIZE / 4);
            let g = 0;
            for (const obj of scene.objects) {
                for (const c of obj.mesh.clusters) {
                    const vb = offsets[g * 2] / 4;
                    for (let k = 0; k < c.positions.length; k++) {
                        input[vb + k] = c.positions[k];
                    }
                    storeBytes(input, offsets[g * 2 + 1], c.indices);
                    // ClasArgsMeta: clusterID, triangles, vertices, vertex and index offsets, the OPAQUE flag
                    // (no translucency or refraction in its material or the object's checker), region.
                    const m = g * CLAS_ARGS_META_SIZE / 4;
                    storeUint(argsMeta, m, c.clusterID);
                    storeUint(argsMeta, m + 1, c.triangleCount());
                    storeUint(argsMeta, m + 2, c.vertexCount());
                    storeUint(argsMeta, m + 3, offsets[g * 2]);
                    storeUint(argsMeta, m + 4, offsets[g * 2 + 1]);
                    storeUint(argsMeta, m + 5, clusterOpaqueFlag(scene, obj, c));
                    storeUint(argsMeta, m + 6, c.matRegionIdx);
                    g++;
                }
            }
            const inputBuffer = clas.createBuffer(inputSize, "Cluster input buffer (vertex + index data)");
            const argsMetaBuffer = clas.createBuffer(argsMeta.length * 4, "Cluster args metadata");
            const argsBuffer = clas.createBuffer(clusterCount * CLAS_ARGS_SIZE, "CLAS-from-triangles args");
            commandList.writeBuffer(inputBuffer, Ref(input[0]), inputSize);
            commandList.writeBuffer(argsMetaBuffer, Ref(argsMeta[0]), argsMeta.length * 4);
            const base = this.address(inputBuffer, 0.0);
            this.dispatch(commandList, this.fillClasArgs, [argsMetaBuffer], [argsBuffer],
                [base[0], base[1], clusterCount, 12, POSITION_TRUNCATE_BITS], clusterCount);

            // BuildSharedClusterTrianglesInputs: FLOAT32_3, the geometry index up to the material table's
            // stride, 12 truncated bits.
            const clasOp = clasParams(OP_CLAS_FROM_TRIANGLES, MODE_IMPLICIT, FLAG_FAST_TRACE, clusterCount);
            setClusterLimits(clasOp, MAX_GEOMS_PER_INSTANCE - 1, maxTriangles, maxVertices, totalTriangles, totalVertices);
            clasOp[10] = VERTEX_FORMAT_FLOAT32_3;
            clasOp[12] = POSITION_TRUNCATE_BITS;
            const clasSizes = this.operationSizes(clasOp);
            const clasStorage = clas.createStorage(clasSizes[0], "All-cluster CLAS result buffer");
            const clasScratch = clas.createBuffer(fmax(clasSizes[1], 256.0), "CLAS scratch");
            const clasAddresses = clas.createBuffer(clusterCount * 8, "CLAS address array");
            clas.executeOperation(commandList.handle, Ref(clasOp[0]), argsBuffer, 0.0, CLAS_ARGS_SIZE, null,
                clasStorage, clasScratch, clasAddresses, 0.0, null, 0.0, inputBuffer, null);

            // The cluster BLASes: each object's slice of the CLAS addresses, into a pool slot of the size
            // its cluster count needs.
            const objectCount = scene.objects.length;
            let maxClasPerArg = 0;
            for (const obj of scene.objects) {
                if (obj.clusterCount > maxClasPerArg) {
                    maxClasPerArg = obj.clusterCount;
                }
            }
            const blasOp = clasParams(OP_BLAS_FROM_CLAS, MODE_EXPLICIT, FLAG_FAST_TRACE, objectCount);
            blasOp[13] = clusterCount;
            blasOp[14] = maxClasPerArg;
            const blasSizes = this.operationSizes(blasOp);
            const sizeCounts: int[] = [];
            const sizeBytes: number[] = [];
            let poolBytes = 0.0;
            for (const obj of scene.objects) {
                let size = -1.0;
                for (let k = 0; k < sizeCounts.length; k++) {
                    if (sizeCounts[k] == obj.clusterCount) {
                        size = sizeBytes[k];
                    }
                }
                if (size < 0.0) {
                    const one = clasParams(OP_BLAS_FROM_CLAS, MODE_EXPLICIT, FLAG_FAST_TRACE, 1);
                    one[13] = obj.clusterCount;
                    one[14] = obj.clusterCount;
                    size = this.operationSizes(one)[0];
                    sizeCounts.push(obj.clusterCount);
                    sizeBytes.push(size);
                }
                this.staticBlasOffsets.push(poolBytes);
                poolBytes += Math.floor((size + 255.0) / 256.0) * 256.0;
            }
            const pool = clas.createStorage(poolBytes, "Cluster BLAS pool (all objects)");
            this.staticBlasPool = pool;
            const blasMeta: int[] = [];
            const destinations: int[] = [];
            for (let i = 0; i < objectCount; i++) {
                const slice = this.address(clasAddresses, scene.objects[i].globalClusterStart * 8);
                blasMeta.push(scene.objects[i].clusterCount);
                blasMeta.push(slice[0]);
                blasMeta.push(slice[1]);
                const destination = this.address(pool, this.staticBlasOffsets[i]);
                destinations.push(destination[0]);
                destinations.push(destination[1]);
            }
            const blasMetaBuffer = clas.createBuffer(objectCount * BLAS_ARGS_META_SIZE, "BLAS args metadata (multi-object)");
            const blasArgs = clas.createBuffer(objectCount * BLAS_ARGS_SIZE, "BLAS args (multi-object)");
            const blasDestinations = clas.createBuffer(objectCount * 8, "BLAS dest addrs (multi-object)");
            commandList.writeBuffer(blasMetaBuffer, Ref(blasMeta[0]), blasMeta.length * 4);
            commandList.writeBuffer(blasDestinations, Ref(destinations[0]), destinations.length * 4);
            this.dispatch(commandList, this.fillBlasArgs, [blasMetaBuffer], [blasArgs], [objectCount, 8], objectCount);
            const blasScratch = clas.createBuffer(fmax(blasSizes[1], 256.0), "Cluster BLAS scratch");
            clas.executeOperation(commandList.handle, Ref(blasOp[0]), blasArgs, 0.0, BLAS_ARGS_SIZE, null,
                pool, blasScratch, blasDestinations, 0.0, null, 0.0, clasAddresses, clasStorage);
        }

        // BuildAnimatedObjectSetup (clustered path) and BuildAnimatedClonesSetup: cluster templates built
        // once from hint vertices (the rest pose x 1.30), the rest pose for the deforming shader, the
        // instantiation arguments the fill shader writes (each template with its slice of the deformed
        // vertices), the per-frame CLAS storage, and one BLAS pool for the sphere and its clones.
        private buildAnimatedSetup(commandList: CommandList) {
            const scene = this.scene;
            const clas = this.clas;
            const mesh = scene.animated;
            const clusterCount = mesh.clusters.length;
            const envelope = f(1.30);
            let maxTriangles = 0;
            let maxVertices = 0;
            let totalVertices = 0;
            const offsets: int[] = [];
            let cursor = 0;
            for (const c of mesh.clusters) {
                if (c.triangleCount() > maxTriangles) {
                    maxTriangles = c.triangleCount();
                }
                if (c.vertexCount() > maxVertices) {
                    maxVertices = c.vertexCount();
                }
                totalVertices += c.vertexCount();
                cursor = alignUp(cursor, 16);
                offsets.push(cursor);
                cursor += c.vertexCount() * 12;
                cursor = alignUp(cursor, 16);
                offsets.push(cursor);
                cursor += c.indices.length;
            }
            const inputSize = alignUp(cursor, 256);
            const input = zeros(inputSize / 4);
            const meta: int[] = [];
            const rest: f32[] = [];
            const vertexOffsets: int[] = [];
            let vertexCursor = 0;
            for (let c = 0; c < clusterCount; c++) {
                const cluster = mesh.clusters[c];
                const vb = offsets[c * 2] / 4;
                for (let k = 0; k < cluster.positions.length; k++) {
                    input[vb + k] = f(cluster.positions[k] * envelope);
                    rest.push(cluster.positions[k]);
                }
                storeBytes(input, offsets[c * 2 + 1], cluster.indices);
                meta.push(cluster.triangleCount());
                meta.push(cluster.vertexCount());
                meta.push(offsets[c * 2]);
                meta.push(offsets[c * 2 + 1]);
                vertexOffsets.push(vertexCursor);
                vertexCursor += cluster.vertexCount() * 12;
            }

            const templateInput = clas.createBuffer(inputSize, "Animated: cluster-template input buffer (vert+idx)");
            const templateMeta = clas.createBuffer(meta.length * 4, "Animated: template args metadata");
            const templateArgs = clas.createBuffer(clusterCount * TEMPLATE_ARGS_SIZE, "Animated: template args");
            commandList.writeBuffer(templateInput, Ref(input[0]), inputSize);
            commandList.writeBuffer(templateMeta, Ref(meta[0]), meta.length * 4);
            const base = this.address(templateInput, 0.0);
            this.dispatch(commandList, this.fillTemplateArgs, [templateMeta], [templateArgs],
                [base[0], base[1], clusterCount, POSITION_TRUNCATE_BITS, 0, 0], clusterCount);

            // BUILD_CLUSTER_TEMPLATES_FROM_TRIANGLES: FLOAT32_3 hints and instantiations, data access (the
            // hit shaders' TriangleObjectPositions()).
            const templateOp = clasParams(OP_TEMPLATES_FROM_TRIANGLES, MODE_IMPLICIT, FLAG_FAST_TRACE | FLAG_ALLOW_DATA_ACCESS,
                clusterCount);
            setClusterLimits(templateOp, 0, maxTriangles, maxVertices, mesh.totalTriangles, totalVertices);
            templateOp[10] = VERTEX_FORMAT_FLOAT32_3;
            templateOp[11] = VERTEX_FORMAT_FLOAT32_3;
            const templateSizes = this.operationSizes(templateOp);
            const templateStorage = clas.createStorage(templateSizes[0], "Animated: cluster templates result buffer");
            const templateScratch = clas.createBuffer(fmax(templateSizes[1], 256.0), "Animated: cluster templates scratch");
            const templateAddresses = clas.createBuffer(clusterCount * 8, "Animated: cluster templates address array");
            clas.executeOperation(commandList.handle, Ref(templateOp[0]), templateArgs, 0.0, TEMPLATE_ARGS_SIZE, null,
                templateStorage, templateScratch, templateAddresses, 0.0, null, 0.0, templateInput, null);
            this.templateStorage = templateStorage;

            // The deformed vertices (AnimateBall writes them each frame from the rest pose).
            const vertexBytes = alignUp(totalVertices * 12, 256);
            const restPositions = clas.createBuffer(vertexBytes, "Animated: rest-pose positions");
            commandList.writeBuffer(restPositions, Ref(rest[0]), rest.length * 4);
            this.restPositions = restPositions;
            const animatedVertices = clas.createBuffer(vertexBytes, "Animated: per-frame vertex buffer");
            this.animatedVertices = animatedVertices;
            storeUint(this.animateData, 1, totalVertices);

            // The instantiation arguments: each template, its cluster ID offset (after the static and
            // clone ranges), its slice of the deformed vertices.
            const offsetBuffer = clas.createBuffer(vertexOffsets.length * 4, "Animated: per-cluster VB byte offsets");
            commandList.writeBuffer(offsetBuffer, Ref(vertexOffsets[0]), vertexOffsets.length * 4);
            const instantiateArgs = clas.createBuffer(alignUp(clusterCount * INSTANTIATE_ARGS_SIZE, 256),
                "Animated: per-frame instantiate args");
            this.instantiateArgs = instantiateArgs;
            const vertices = this.address(animatedVertices, 0.0);
            this.dispatch(commandList, this.fillInstantiateArgs, [offsetBuffer], [instantiateArgs, templateAddresses],
                [vertices[0], vertices[1], clusterCount, scene.animatedClusterIdOffset, 12], clusterCount);

            // INSTANTIATE_CLUSTER_TEMPLATES into implicit destinations each frame.
            const instantiateOp = clasParams(OP_INSTANTIATE_TEMPLATES, MODE_IMPLICIT, FLAG_FAST_TRACE, clusterCount);
            setClusterLimits(instantiateOp, 0, maxTriangles, maxVertices, mesh.totalTriangles, totalVertices);
            instantiateOp[10] = VERTEX_FORMAT_FLOAT32_3;
            this.instantiateParams = instantiateOp;
            const instantiateSizes = this.operationSizes(instantiateOp);
            this.animatedClasStorage = clas.createStorage(instantiateSizes[0], "Animated: per-frame CLAS result");
            this.animatedClasScratch = clas.createBuffer(fmax(instantiateSizes[1], 256.0), "Animated: per-frame CLAS scratch");
            const animatedClasAddresses = clas.createBuffer(clusterCount * 8, "Animated: per-frame CLAS address array");
            this.animatedClasAddresses = animatedClasAddresses;

            // The BLASes: the sphere's and each clone's, from the same CLASes, slots of one pool.
            const blasCount = 1 + scene.animatedClones.length;
            const single = clasParams(OP_BLAS_FROM_CLAS, MODE_EXPLICIT, FLAG_FAST_TRACE, 1);
            single[13] = clusterCount;
            single[14] = clusterCount;
            const perBlas = Math.floor((this.operationSizes(single)[0] + 255.0) / 256.0) * 256.0;
            this.animatedBlasSize = perBlas;
            const blasOp = clasParams(OP_BLAS_FROM_CLAS, MODE_EXPLICIT, FLAG_FAST_TRACE, blasCount);
            blasOp[13] = clusterCount * blasCount;
            blasOp[14] = clusterCount;
            this.animatedBlasParams = blasOp;
            const batchSizes = this.operationSizes(blasOp);
            const pool = clas.createStorage(perBlas * blasCount, "Animated: BLAS pool (sphere + clones)");
            this.animatedBlasPool = pool;
            this.animatedBlasScratch = clas.createBuffer(fmax(batchSizes[1], 256.0), "Animated: BLAS scratch");
            const clasArray = this.address(animatedClasAddresses, 0.0);
            const args: int[] = [];
            const destinations: int[] = [];
            for (let k = 0; k < blasCount; k++) {
                args.push(clusterCount);
                args.push(8);
                args.push(clasArray[0]);
                args.push(clasArray[1]);
                const destination = this.address(pool, k * perBlas);
                destinations.push(destination[0]);
                destinations.push(destination[1]);
            }
            const blasArgs = clas.createBuffer(args.length * 4, "Animated: BLAS args (1+N)");
            const blasDestinations = clas.createBuffer(destinations.length * 4, "Animated: BLAS dest addrs (1+N)");
            commandList.writeBuffer(blasArgs, Ref(args[0]), args.length * 4);
            commandList.writeBuffer(blasDestinations, Ref(destinations[0]), destinations.length * 4);
            this.animatedBlasArgs = blasArgs;
            this.animatedBlasDestinations = blasDestinations;
        }

        // The hit shaders' tables, the materials, the TLAS instances.
        private uploadTables(commandList: CommandList) {
            const scene = this.scene;
            const app = this.app;
            const meta = scene.clusterMeta();
            const normals: f32[] = [];
            const indices: int[] = [];
            const offsets: int[] = [];
            scene.sideBuffers(normals, indices, offsets);
            const materials: f32[] = [];
            for (const value of MATERIALS) {
                materials.push(value);
            }
            const perInstanceMaterials = scene.perInstanceGeometryMaterials();
            const overrides = scene.materialOverrides();

            const materialBuffer = app.createStructuredBuffer(MATERIAL_SIZE, MATERIAL_SLOTS, "Per-instance materials");
            const normalBuffer = app.createRawBuffer(normals.length * 4, "Cluster vertex normals");
            const indexBuffer = app.createRawBuffer(indices.length * 4, "Cluster indices");
            const offsetBuffer = app.createRawBuffer(offsets.length * 4, "Cluster vert/idx offset table");
            const metaBuffer = app.createRawBuffer(meta.length * 4, "Per-cluster metadata");
            // The traditional path's cluster ID tables (the clustered path's shaders don't read them).
            const traditionalTriangles = app.createRawBuffer(16, "Traditional tri-to-cid (unused)");
            const traditionalBases = app.createRawBuffer(16, "Traditional geom tri-base (unused)");
            const perInstanceBuffer = app.createRawBuffer(perInstanceMaterials.length * 4, "Per-(InstIdx, GeomIdx) materials");
            const overrideBuffer = app.createStructuredBuffer(4, overrides.length, "Per-instance material overrides");
            commandList.writeBuffer(materialBuffer, Ref(materials[0]), materials.length * 4);
            commandList.writeBuffer(normalBuffer, Ref(normals[0]), normals.length * 4);
            commandList.writeBuffer(indexBuffer, Ref(indices[0]), indices.length * 4);
            commandList.writeBuffer(offsetBuffer, Ref(offsets[0]), offsets.length * 4);
            commandList.writeBuffer(metaBuffer, Ref(meta[0]), meta.length * 4);
            commandList.writeBuffer(perInstanceBuffer, Ref(perInstanceMaterials[0]), perInstanceMaterials.length * 4);
            commandList.writeBuffer(overrideBuffer, Ref(overrides[0]), overrides.length * 4);
            this.shaderBuffers = [materialBuffer, normalBuffer, indexBuffer, offsetBuffer, metaBuffer, traditionalTriangles,
                traditionalBases, perInstanceBuffer, overrideBuffer];

            // The instances: the static objects' BLASes in their pool, the animated ones in theirs.
            const blasAddresses: int[] = [];
            for (let i = 0; i < scene.objects.length; i++) {
                const a = this.address(this.staticBlasPool as BufferHandle, this.staticBlasOffsets[i]);
                blasAddresses.push(a[0]);
                blasAddresses.push(a[1]);
            }
            for (let k = 0; k <= scene.animatedClones.length; k++) {
                const a = this.address(this.animatedBlasPool as BufferHandle, k * this.animatedBlasSize);
                blasAddresses.push(a[0]);
                blasAddresses.push(a[1]);
            }
            const instances = scene.instances(blasAddresses);
            const instanceBuffer = this.clas.createBuffer(instances.length * 4, "TLAS instance descs");
            commandList.writeBuffer(instanceBuffer, Ref(instances[0]), instances.length * 4);
            this.tlasInstances = instanceBuffer;
            this.tlas = this.clas.createTlas(scene.instanceCount(), AccelStructBuildFlags.PreferFastTrace, "TLAS");
            this.sceneConstantBuffer = app.createConstantBuffer(256, "Scene constants");

            if (this.settings.dumpScenePath != "") {
                this.dumpScene(meta, normals, indices, offsets, perInstanceMaterials, overrides, instances);
            }
        }

        // -dumpScene: the tables the reference's dump hooks write, for a script to compare.
        private dumpScene(meta: f32[], normals: f32[], indices: int[], offsets: int[], perInstanceMaterials: int[],
            overrides: int[], instances: f32[]) {
            const scene = this.scene;
            const dir = this.settings.dumpScenePath;
            const positions: f32[] = [];
            const clasArgs: int[] = [];
            for (const obj of scene.objects) {
                for (const c of obj.mesh.clusters) {
                    for (const p of c.positions) {
                        positions.push(p);
                    }
                    clasArgs.push(c.clusterID);
                    clasArgs.push(c.triangleCount());
                    clasArgs.push(c.vertexCount());
                    clasArgs.push(clusterOpaqueFlag(scene, obj, c));
                    clasArgs.push(c.matRegionIdx);
                }
            }
            const rest: f32[] = [];
            for (const c of scene.animated.clusters) {
                for (const p of c.positions) {
                    rest.push(p);
                }
            }
            const cb = sceneConstants(1280, 720, 0.0, 0.0, false);
            Donut_WriteBinaryFile(`${dir}/positions.bin`, Ref(positions[0]), positions.length * 4);
            Donut_WriteBinaryFile(`${dir}/clasargs.bin`, Ref(clasArgs[0]), clasArgs.length * 4);
            Donut_WriteBinaryFile(`${dir}/normals.bin`, Ref(normals[0]), normals.length * 4);
            Donut_WriteBinaryFile(`${dir}/indices.bin`, Ref(indices[0]), indices.length * 4);
            Donut_WriteBinaryFile(`${dir}/offsets.bin`, Ref(offsets[0]), offsets.length * 4);
            Donut_WriteBinaryFile(`${dir}/clustermeta.bin`, Ref(meta[0]), meta.length * 4);
            Donut_WriteBinaryFile(`${dir}/animrest.bin`, Ref(rest[0]), rest.length * 4);
            Donut_WriteBinaryFile(`${dir}/instances.bin`, Ref(instances[0]), instances.length * 4);
            Donut_WriteBinaryFile(`${dir}/overrides.bin`, Ref(overrides[0]), overrides.length * 4);
            Donut_WriteBinaryFile(`${dir}/pergeommat.bin`, Ref(perInstanceMaterials[0]), perInstanceMaterials.length * 4);
            Donut_WriteBinaryFile(`${dir}/scenecb.bin`, Ref(cb[0]), cb.length * 4);
        }

        // CreateRaytracingPipelineAndShaderTables: RayGen, Miss, ShadowMiss; the opaque, glass, wireframe
        // and (empty) shadow hit groups; clustered geometry allowed. The hit group table: the opaque
        // block, then glass blocks up to every contribution + geometry index (a shadow record after each
        // primary); wireframe mode's table all wireframe records.
        private createRayTracingPipeline() {
            const shaderLibrary = this.app.createShaderLibrary("clustered_geometry/Raytracing.hlsl");
            if (!shaderLibrary) {
                return false;
            }
            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutTextureUAV(0);
            layoutDesc.layoutAccelStruct(0);
            layoutDesc.layoutConstantBuffer(0);
            layoutDesc.layoutStructuredBufferSRV(1);
            for (let t = 2; t <= 8; t++) {
                layoutDesc.layoutRawBufferSRV(t);
            }
            layoutDesc.layoutStructuredBufferSRV(9);
            const layout = this.app.createBindingLayout(layoutDesc, ShaderType.All);
            this.rayTracingLayout = layout;

            const pipelineDesc = RtPipelineDesc.create(PAYLOAD_SIZE, MAX_RECURSION_DEPTH);
            pipelineDesc.setMaxAttributeSize(ATTRIBUTE_SIZE);
            pipelineDesc.addGlobalBindingLayout(layout);
            pipelineDesc.addShader(shaderLibrary, "RayGen", ShaderType.RayGeneration);
            pipelineDesc.addShader(shaderLibrary, "Miss", ShaderType.Miss);
            pipelineDesc.addShader(shaderLibrary, "ShadowMiss", ShaderType.Miss);
            pipelineDesc.addHitGroup(shaderLibrary, "OpaqueHitGroup", "OpaqueHit", "", null);
            pipelineDesc.addHitGroup(shaderLibrary, "GlassHitGroup", "GlassHit", "GlassAnyHit", null);
            pipelineDesc.addHitGroup(shaderLibrary, "WireframeHitGroup", "WireframeHit", "WireframeAnyHit", null);
            pipelineDesc.addHitGroup(shaderLibrary, "ShadowHitGroup", "", "", null);
            pipelineDesc.setAllowClusteredGeometry(true);
            const pipeline = this.app.createRayTracingPipelineFromDesc(pipelineDesc);
            if (!pipeline) {
                return false;
            }
            this.shaderTable = this.createShaderTable(pipeline, false);
            this.wireframeTable = this.createShaderTable(pipeline, true);
            // The shader tables keep the pipeline alive.
            this.app.releaseResource(pipeline);
            return true;
        }

        private createShaderTable(pipeline: RtPipelineHandle, wireframe: boolean): ShaderTable {
            const table = this.app.createEmptyShaderTable(pipeline);
            table.setRayGeneration("RayGen");
            table.addMiss("Miss");
            table.addMiss("ShadowMiss");
            for (let record = 0; record < HIT_GROUP_RECORDS; record++) {
                if (wireframe) {
                    table.addHitGroup("WireframeHitGroup", null);
                } else if (record % 2 == 1) {
                    table.addHitGroup("ShadowHitGroup", null);
                } else {
                    table.addHitGroup(record == 0 ? "OpaqueHitGroup" : "GlassHitGroup", null);
                }
            }
            return table;
        }

        onBackBufferResizing() {
            const set = this.rayTracingSet;
            if (!set.isNull()) {
                this.app.releaseResource(set.handle);
                this.rayTracingSet = new BindingSet(null);
            }
            const output = this.output;
            if (output) {
                this.app.releaseResource(output);
                this.output = null;
            }
        }

        private createOutput(frame: Frame) {
            // UNORM, in the back buffer's channel order, for the copy to the frame.
            const output = this.app.createUAVTextureForFrameCopy(frame, "Raytracing output");
            this.output = output;
            const b = this.shaderBuffers;
            const desc = BindingSetDesc.create();
            desc.bindTextureUAV(0, output);
            desc.bindAccelStruct(0, this.tlas as AccelStructHandle);
            desc.bindConstantBuffer(0, this.sceneConstantBuffer as BufferHandle, 0, 256);
            desc.bindStructuredBufferSRV(1, b[0]);
            for (let t = 2; t <= 8; t++) {
                desc.bindRawBufferSRV(t, b[t - 1]);
            }
            desc.bindStructuredBufferSRV(9, b[8]);
            this.rayTracingSet = this.app.createBindingSetForLayout(desc, this.rayTracingLayout as BindingLayoutHandle);
        }

        onAnimate(elapsedSeconds: number) {
            const settings = this.settings;
            if (!settings.animationPaused) {
                this.animationSeconds += elapsedSeconds;
            }
            if (!settings.cameraPaused) {
                this.cameraSeconds += elapsedSeconds;
            }
        }

        // [W] wireframe, [Space] camera motion, [M] animation.
        onKey(key: Key, scancode: ScanCode, action: Action, mods: KeyMods): int {
            if (action != Action.Press) {
                return 0;
            }
            const settings = this.settings;
            if (key == Key.W) {
                settings.wireframe = !settings.wireframe;
            } else if (key == Key.Space) {
                settings.cameraPaused = !settings.cameraPaused;
            } else if (key == Key.M) {
                settings.animationPaused = !settings.animationPaused;
            } else {
                return 0;
            }
            return 1;
        }

        // DoRender: the animated sphere deformed, its CLASes instantiated and its BLASes (and its
        // clones') rebuilt, the TLAS rebuilt, the rays dispatched, the output copied to the frame.
        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const commandList = frame.getCommandList();
            const width = frame.getWidth();
            const height = frame.getHeight();
            if (this.rayTracingSet.isNull()) {
                this.createOutput(frame);
            }
            const settings = this.settings;
            this.sceneData = sceneConstants(width, height, this.cameraSeconds, this.animationSeconds, settings.wireframe);
            commandList.writeBuffer(this.sceneConstantBuffer as BufferHandle, Ref(this.sceneData[0]), SCENE_CONSTANTS_SIZE);

            const clas = this.clas;
            this.animateData[0] = f(this.animationSeconds);
            this.dispatchAnimate(commandList, this.scene.animated.totalVertices);
            clas.executeOperation(commandList.handle, Ref(this.instantiateParams[0]), this.instantiateArgs as BufferHandle, 0.0,
                INSTANTIATE_ARGS_SIZE, null, this.animatedClasStorage, this.animatedClasScratch as BufferHandle,
                this.animatedClasAddresses, 0.0, null, 0.0, this.animatedVertices, this.templateStorage);
            clas.executeOperation(commandList.handle, Ref(this.animatedBlasParams[0]), this.animatedBlasArgs as BufferHandle, 0.0,
                BLAS_ARGS_SIZE, null, this.animatedBlasPool, this.animatedBlasScratch as BufferHandle,
                this.animatedBlasDestinations, 0.0, null, 0.0, this.animatedClasAddresses, this.animatedClasStorage);
            clas.buildTlas(commandList.handle, this.tlas as AccelStructHandle, this.tlasInstances as BufferHandle,
                this.scene.instanceCount(), AccelStructBuildFlags.PreferFastTrace);

            frame.dispatchRays(settings.wireframe ? this.wireframeTable : this.shaderTable, this.rayTracingSet, width, height);
            const output = this.output;
            if (output) {
                frame.copyTextureToFrame(output);
            }
        }

        private dispatchAnimate(commandList: CommandList, vertexCount: int) {
            const pass = this.animateBall;
            if (!pass) {
                return;
            }
            if (this.animateSet.isNull()) {
                const desc = BindingSetDesc.create();
                desc.bindRawBufferSRV(0, this.restPositions as BufferHandle);
                desc.bindRawBufferUAV(0, this.animatedVertices as BufferHandle);
                desc.bindPushConstants(0, pass.pushConstantBytes);
                this.animateSet = this.app.createBindingSetForLayout(desc, pass.layout);
            }
            commandList.dispatchWithPushConstants(pass.pipeline, this.animateSet, Ref(this.animateData[0]), pass.pushConstantBytes,
                Math.floor((vertexCount + GROUP_SIZE - 1) / GROUP_SIZE), 1, 1);
        }
    }

    // A static cluster's D3D12_RTAS_CLUSTERED_GEOMETRY_FLAG_OPAQUE: neither its material nor its object's
    // checker translucent or refractive.
    function clusterOpaqueFlag(scene: Scene, obj: SceneObject, c: Cluster): int {
        const slot = scene.clusterMaterial(obj, c);
        const opaque = materialTranslucency(slot) == 0.0 && materialRefractivity(slot) == 0.0 && !obj.checkerCouldRefract();
        return opaque ? CLUSTER_FLAG_OPAQUE : 0;
    }

    class ClusteredGeometryArgs extends Args {
        // -extraInstances 0|100|1000|10000 (the sample's --extra-instances), -wireframe, -cameraPaused,
        // -animPaused (both paused in test mode, as the reference runs), -dumpScene <dir>.
        settings = new Settings();

        protected parseOptions() {
            const settings = this.settings;
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-wireframe") {
                    settings.wireframe = true;
                } else if (arg == "-cameraPaused") {
                    settings.cameraPaused = true;
                } else if (arg == "-animPaused") {
                    settings.animationPaused = true;
                } else if (arg == "-extraInstances" && i + 1 < this.argc) {
                    i++;
                    const n = parseInt(this[i]);
                    settings.extraInstances = n >= 10000 ? 10000 : n >= 1000 ? 1000 : n >= 100 ? 100 : 0;
                } else if (arg == "-dumpScene" && i + 1 < this.argc) {
                    i++;
                    settings.dumpScenePath = this[i];
                }
            }
        }
    }

    // -test: checks the last frame: the sky at the top corners, and the clusters' colors.
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        const failure = check.frameRead();
        if (failure != "") {
            return failure;
        }
        const w = check.width;
        const h = check.height;
        if (check.countInRange(20, 90, 60, 130, 140, 210, 0, 0, 1, 1) != 1
            || check.countInRange(20, 90, 60, 130, 140, 210, w - 1, 0, 1, 1) != 1) {
            const p = check.rgb(0, 0);
            return `the top corners aren't the sky: ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}`;
        }
        const colored = check.countSpread(80, false, 0, 0, 0, w, h);
        return check.share(colored, w * h, 2.0, 60.0, "Cluster-colored");
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Program.setAppName("clustered_geometry");

        const args = new ClusteredGeometryArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();
        const settings = args.settings;
        if (args.test) {
            settings.cameraPaused = true;
            settings.animationPaused = true;
        }
        if (args.api != GraphicsAPI.D3D12) {
            return unsupported(args.test, "Clustered geometry is D3D12's preview here (Vulkan's VK_NV_cluster_acceleration_structure: not yet)");
        }
        // The preview's experimental features before the device (the executable loads the preview
        // runtime, which needs Windows' Developer Mode).
        if (Donut_EnableD3D12RaytracingPreview() == 0) {
            return unsupported(args.test, "The D3D12 raytracing preview is unavailable (needs the preview Agility SDK and Developer Mode)");
        }
        // UNORM back buffers, as the sample's B8G8R8A8_UNORM.
        const options = AppOptions.RayTracing | AppOptions.UnormBackBuffer | args.options;
        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        if (!app.isFeatureSupported(Feature.RayTracingPipeline)) {
            app.destroy();
            return unsupported(args.test, "The graphics device does not support ray tracing pipelines");
        }
        const clas = Clas.create(app.getNvrhiDevice());
        if (clas.isNull()) {
            app.destroy();
            return unsupported(args.test, "The graphics device does not support clustered geometry (CLASes and shader model 6.10)");
        }
        console.log(`Renderer: ${app.getRendererString()}`);

        const scene = new Scene();
        scene.build(app, settings.extraInstances);
        console.log(`${scene.objects.length} objects (${scene.sourceCount} + clones), ${scene.totalClusterCount} static clusters, `
            + `${scene.animated.clusters.length} animated clusters, ${scene.animatedClones.length} animated clones`);

        const pass = new ClusteredGeometryPass(app, clas, scene, settings);
        if (!pass.init()) {
            clas.destroy();
            app.destroy();
            return 1;
        }
        const input = new InputPass(app.handle);

        app.run();
        let result = 0;
        if (args.test) {
            result = app.finishTest(checkFrame(app));
        }
        app.waitForIdle();
        clas.destroy();
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return ClusteredGeometry.main(argc, argv);
}

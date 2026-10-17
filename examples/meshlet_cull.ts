// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { unsupported } from "../core/test_check";
import { MeshletModel } from "../core/meshlet_model";
import {
    dot3, matrixIdentity, matrixInverse, matrixLookToRH, matrixMultiply, matrixPerspectiveFovRH,
    matrixScaling, matrixTranspose, normalize3, planeNormalize, row, transform3, transformCoord3,
    transformNormal3, vadd, vsub, XM_PI,
} from "../core/directx_math";

namespace MeshletCull {
    const WINDOW_TITLE = "D3D12 Mesh Shader Culling";
    const MEDIA_DIR = "media/meshlet_cull/";

    // GLFW values, as passed to the keyboard callback.
    const KEY_SPACE = 32;
    const KEY_A = 65;
    const KEY_D = 68;
    const KEY_S = 83;
    const KEY_W = 87;
    const KEY_TAB = 258;
    const KEY_RIGHT = 262;
    const KEY_LEFT = 263;
    const KEY_DOWN = 264;
    const KEY_UP = 265;
    const KEY_LEFT_SHIFT = 340;
    const KEY_RIGHT_SHIFT = 344;
    const ACTION_PRESS = 1;
    const ACTION_RELEASE = 0;

    // Shared.h.
    const AS_GROUP_SIZE = 32;
    const CULL_FLAG = 1;
    const MESHLET_FLAG = 2;

    // Constants (256 bytes): View, ViewProj, Planes[6], ViewPosition, HighlightedIndex (uint),
    // CullViewPosition, SelectedIndex (uint), DrawMeshlets (uint).
    const CONSTANTS_SIZE = 512;
    const CONSTANT_FLOATS = 63;
    const HIGHLIGHTED_OFFSET = 236;
    const SELECTED_OFFSET = 252;
    const DRAW_MESHLETS_OFFSET = 256;
    // Instance (256 bytes): World, WorldInvTrans, Scale, Flags (uint).
    const INSTANCE_SIZE = 256;
    const INSTANCE_FLOATS = 33;
    const FLAGS_OFFSET = 132;
    // MeshInfo: IndexSize, MeshletCount, LastMeshletVertCount, LastMeshletPrimCount.
    const MESH_INFO_SIZE = 256;
    // FrustumVisualizer's Constants: ViewProj, Planes[6], LineColor.
    const FRUSTUM_CONSTANTS_SIZE = 256;
    const FRUSTUM_FLOATS = 44;
    // CullDataVisualizer's Constants: World, ViewProj, Color, ViewUp (float4), ViewForward, Scale.
    const CULL_DATA_CONSTANTS_SIZE = 256;
    const CULL_DATA_FLOATS = 48;
    // Its root constants: MeshletOffset, MeshletCount.
    const OPTIONS_SIZE = 8;
    // The files' records: vertices (position, normal), meshlets (4 uints), culling data (bounding
    // sphere, packed normal cone, apex offset).
    const VERTEX_STRIDE = 24;
    const MESHLET_STRIDE = 16;
    const CULL_DATA_STRIDE = 24;

    // The sample's clear color, (0, 0.2, 0.4).
    const CLEAR_R = 0.0;
    const CLEAR_G = 0.2;
    const CLEAR_B = 0.4;

    // DirectX::Colors::Purple and Yellow.
    const PURPLE = Math.fround(0.501960814);

    // Test mode: the frames rendered, each 1/60 s; the mouse at the window's center, and the
    // meshlet under it selected before the second frame (as Tab would).
    const TEST_FRAMES = 3;

    // The sample's c_sceneDefinition: the dragon (culled, in meshlet colors), and the culling
    // camera's model, whose transform follows that camera.
    const MODEL_FILES = ["Dragon_LOD0.bin", "Camera.bin"];
    const OBJECT_SCALES = [0.2, 1.0];
    const OBJECT_FLAGS = [CULL_FLAG | MESHLET_FLAG, 0];
    const VIEW_MODEL = 0;
    const DEBUG_CAMERA = 1;

    // DirectX-Graphics-Samples' SimpleCamera: WASD move it, the arrow keys turn it (pitch within 45
    // degrees up and down), at its move and turn speeds per second.
    class SimpleCamera {
        private initialPosition: number[];
        position: number[];
        private yaw: number;
        private pitch: number;
        lookDirection: number[];
        private moveSpeed: number;
        private turnSpeed: number;
        private keys: int[];

        constructor() {
            this.initialPosition = [0.0, 0.0, 0.0, 0.0];
            this.position = [0.0, 0.0, 0.0, 0.0];
            this.yaw = XM_PI;
            this.pitch = 0.0;
            this.lookDirection = [0.0, 0.0, -1.0, 0.0];
            this.moveSpeed = 20.0;
            this.turnSpeed = Math.fround(XM_PI / 2.0);
            // w, a, s, d, left, right, up, down.
            this.keys = [0, 0, 0, 0, 0, 0, 0, 0];
        }

        init(x: number, y: number, z: number) {
            this.initialPosition = [Math.fround(x), Math.fround(y), Math.fround(z), 0.0];
            this.reset();
        }

        setMoveSpeed(unitsPerSecond: number) {
            this.moveSpeed = Math.fround(unitsPerSecond);
        }

        reset() {
            this.position = [this.initialPosition[0], this.initialPosition[1], this.initialPosition[2], 0.0];
            this.yaw = XM_PI;
            this.pitch = 0.0;
            this.lookDirection = [0.0, 0.0, -1.0, 0.0];
        }

        onKey(key: int, down: boolean) {
            let index = -1;
            if (key == KEY_W) {
                index = 0;
            } else if (key == KEY_A) {
                index = 1;
            } else if (key == KEY_S) {
                index = 2;
            } else if (key == KEY_D) {
                index = 3;
            } else if (key == KEY_LEFT) {
                index = 4;
            } else if (key == KEY_RIGHT) {
                index = 5;
            } else if (key == KEY_UP) {
                index = 6;
            } else if (key == KEY_DOWN) {
                index = 7;
            }
            if (index >= 0) {
                this.keys[index] = down ? 1 : 0;
            }
        }

        update(elapsedSeconds: number) {
            const k = this.keys;
            // The move vector in camera space.
            let moveX = 0.0;
            let moveZ = 0.0;
            if (k[1] != 0) {
                moveX -= 1.0;
            }
            if (k[3] != 0) {
                moveX += 1.0;
            }
            if (k[0] != 0) {
                moveZ -= 1.0;
            }
            if (k[2] != 0) {
                moveZ += 1.0;
            }
            if (Math.abs(moveX) > 0.1 && Math.abs(moveZ) > 0.1) {
                const length = Math.fround(Math.sqrt(moveX * moveX + moveZ * moveZ));
                moveX = Math.fround(moveX / length);
                moveZ = Math.fround(moveZ / length);
            }

            const moveInterval = Math.fround(this.moveSpeed * elapsedSeconds);
            const rotateInterval = Math.fround(this.turnSpeed * elapsedSeconds);
            if (k[4] != 0) {
                this.yaw = Math.fround(this.yaw + rotateInterval);
            }
            if (k[5] != 0) {
                this.yaw = Math.fround(this.yaw - rotateInterval);
            }
            if (k[6] != 0) {
                this.pitch = Math.fround(this.pitch + rotateInterval);
            }
            if (k[7] != 0) {
                this.pitch = Math.fround(this.pitch - rotateInterval);
            }
            // Prevent looking too far up or down. Not Math.max: tslang's starts from
            // Number.MIN_VALUE, above any negative number.
            const quarterPi = Math.fround(XM_PI / 4.0);
            if (this.pitch > quarterPi) {
                this.pitch = quarterPi;
            }
            if (this.pitch < -quarterPi) {
                this.pitch = -quarterPi;
            }

            // Move the camera in model space.
            const cosYaw = Math.fround(Math.cos(this.yaw));
            const sinYaw = Math.fround(Math.sin(this.yaw));
            const x = Math.fround(Math.fround(moveX * -cosYaw) - Math.fround(moveZ * sinYaw));
            const z = Math.fround(Math.fround(moveX * sinYaw) - Math.fround(moveZ * cosYaw));
            this.position[0] = Math.fround(this.position[0] + Math.fround(x * moveInterval));
            this.position[2] = Math.fround(this.position[2] + Math.fround(z * moveInterval));

            // The look direction.
            const r = Math.fround(Math.cos(this.pitch));
            this.lookDirection = [Math.fround(r * sinYaw), Math.fround(Math.sin(this.pitch)), Math.fround(r * cosYaw), 0.0];
        }

        viewMatrix() {
            return matrixLookToRH(this.position, this.lookDirection, [0.0, 1.0, 0.0, 0.0]);
        }

        // Near 1, far farZ.
        projectionMatrix(fovY: number, aspectRatio: number, farZ: number) {
            return matrixPerspectiveFovRH(fovY, aspectRatio, 1.0, farZ);
        }
    }

    // A mesh of a model: its GPU buffers and binding set, and its meshlets, primitives, unique
    // vertex indices, positions and culling data on the CPU, for picking.
    class MeshletMesh {
        bindingSet: BindingSet;
        // The culling data visualizer's binding set for the mesh.
        cullDataSet: BindingSet;
        cullDataBuffer: BufferHandle;
        meshletCount: int;
        indexSize: int;
        meshlets: int[];
        primitives: int[];
        uniqueIndices: int[];
        vertices: f32[];
        cullFloats: f32[];

        constructor(bindingSet: BindingSet, cullDataBuffer: BufferHandle, meshletCount: int, indexSize: int) {
            this.bindingSet = bindingSet;
            this.cullDataSet = bindingSet;
            this.cullDataBuffer = cullDataBuffer;
            this.meshletCount = meshletCount;
            this.indexSize = indexSize;
            this.meshlets = [];
            this.primitives = [];
            this.uniqueIndices = [];
            this.vertices = [];
            this.cullFloats = [];
        }

        // Mesh::GetVertexIndex: the index-th unique vertex index, 16- or 32-bit.
        vertexIndex(index: int): int {
            if (this.indexSize == 4) {
                return this.uniqueIndices[index];
            }
            const pair = this.uniqueIndices[index >> 1];
            return (index & 1) == 0 ? pair & 0xFFFF : (pair >> 16) & 0xFFFF;
        }
    }

    // A scene object: a model, its world transform (row vectors), its Instance constant buffer and flags.
    class SceneObject {
        meshes: MeshletMesh[];
        world: number[];
        instanceBuffer: BufferHandle;
        flags: int;

        constructor(instanceBuffer: BufferHandle, flags: int, scale: number) {
            this.meshes = [];
            this.world = matrixScaling(scale, scale, scale);
            this.instanceBuffer = instanceBuffer;
            this.flags = flags;
        }
    }

    // RayIntersectSphere: whether the ray (o, d) meets the sphere (center, radius in s).
    function rayIntersectSphere(o: number[], d: number[], s: number[]) {
        const l = vsub(o, s);
        const r = s[3];
        const a = dot3(d, d);
        const b = Math.fround(2.0 * dot3(l, d));
        const c = Math.fround(dot3(l, l) - Math.fround(r * r));
        const disc = Math.fround(Math.fround(b * b) - Math.fround(Math.fround(4.0 * a) * c));
        return !(disc < 0.0);
    }

    // RayIntersectTriangle (Moller-Trumbore): the ray's t at the triangle, -1 if it misses it.
    const EPSILON = 1.192092896e-7;
    function rayIntersectTriangle(o: number[], d: number[], p0: number[], p1: number[], p2: number[]) {
        const edge1 = vsub(p1, p0);
        const edge2 = vsub(p2, p0);
        const h = cross(d, edge2);
        const a = dot3(edge1, h);
        if (Math.abs(a) < EPSILON) {
            return -1.0;
        }
        const f = Math.fround(1.0 / a);
        const s = vsub(o, p0);
        const u = Math.fround(f * dot3(s, h));
        if (u < 0.0 || u > 1.0) {
            return -1.0;
        }
        const q = cross(s, edge1);
        const v = Math.fround(f * dot3(d, q));
        if (v < 0.0 || Math.fround(u + v) > 1.0) {
            return -1.0;
        }
        const t = Math.fround(f * dot3(edge2, q));
        if (t > EPSILON && t < 1.0 / EPSILON) {
            return t;
        }
        return -1.0;
    }

    function cross(a: number[], b: number[]) {
        return [
            Math.fround(Math.fround(a[1] * b[2]) - Math.fround(a[2] * b[1])),
            Math.fround(Math.fround(a[2] * b[0]) - Math.fround(a[0] * b[2])),
            Math.fround(Math.fround(a[0] * b[1]) - Math.fround(a[1] * b[0])),
            0.0,
        ];
    }

    // XMMatrixDecompose's scale x: the length of the first row.
    function scaleOf(m: number[]) {
        const r = row(m, 0);
        return Math.fround(Math.sqrt(dot3(r, r)));
    }

    // Port of DirectX-Graphics-Samples' D3D12MeshShaders MeshletCull: an amplification shader per
    // wave of meshlets culls them against the culling (debug) camera's frustum and by their normal
    // cones, launching mesh shader groups for the visible ones. The culling camera's frustum and
    // model are drawn too; the meshlet under the mouse is highlighted (a ray cast on the CPU against
    // the meshlets' bounding spheres and triangles), Tab selects it and draws its bounding sphere and
    // normal cone. Shift moves the culling camera instead of the main one; Space switches meshlet
    // colors. The sample's back buffer (R8G8B8A8_UNORM) and D32_FLOAT depth buffer are a color
    // target here, blitted into the back buffer.
    class MeshletCullPass {
        private app: App;
        private meshPipelineAS: ShaderHandle;
        private meshPipelineMS: ShaderHandle;
        private meshPipelinePS: ShaderHandle;
        private frustumMS: ShaderHandle;
        private sphereMS: ShaderHandle;
        private coneMS: ShaderHandle;
        private debugPS: ShaderHandle;
        private meshLayout: BindingLayoutHandle;
        private frustumLayout: BindingLayoutHandle;
        private cullDataLayout: BindingLayoutHandle;
        private constantBuffer: BufferHandle;
        private frustumBuffer: BufferHandle;
        private cullDataBuffer: BufferHandle;
        private frustumBindingSet: BindingSet;
        private objects: SceneObject[];
        private hasTargets: boolean;
        private colorBuffer: TextureHandle;
        private depthBuffer: TextureHandle;
        private framebuffer: FramebufferHandle;
        private meshPipeline: MeshletPipelineHandle;
        private frustumPipeline: MeshletPipelineHandle;
        private spherePipeline: MeshletPipelineHandle;
        private conePipeline: MeshletPipelineHandle;
        // What OnUpdate wrote, for the frame's render callback.
        private constants: f32[];
        private frustumConstants: f32[];
        private cullDataConstants: f32[];
        private instanceConstants: f32[][];
        private uints: int[];
        private options: int[];
        private mainCam: SimpleCamera;
        private debugCam: SimpleCamera;
        private fovY: number;
        private aspectRatio: number;
        private width: int;
        private height: int;
        private moveCam: boolean;
        drawMeshlets: boolean;
        highlightedIndex: int;
        selectedIndex: int;
        // The mouse position in the window, -1 before the first mouse event.
        mouseX: number;
        mouseY: number;
        // Test mode: select the highlighted meshlet before this frame (1-based), 0 for none.
        selectBeforeFrame: int;
        private frameNumber: int;

        constructor(app: App) {
            this.app = app;
            this.objects = [];
            this.hasTargets = false;
            this.constants = [];
            for (let i = 0; i < CONSTANT_FLOATS; i++) {
                this.constants.push(0.0);
            }
            this.frustumConstants = [];
            for (let i = 0; i < FRUSTUM_FLOATS; i++) {
                this.frustumConstants.push(0.0);
            }
            this.cullDataConstants = [];
            for (let i = 0; i < CULL_DATA_FLOATS; i++) {
                this.cullDataConstants.push(0.0);
            }
            this.instanceConstants = [];
            this.uints = [0, 0, 0, 0];
            this.options = [0, 1];
            this.mainCam = new SimpleCamera();
            this.debugCam = new SimpleCamera();
            this.fovY = Math.fround(XM_PI / 3.0);
            this.aspectRatio = Math.fround(1280.0 / 720.0);
            this.width = 1280;
            this.height = 720;
            this.moveCam = false;
            this.drawMeshlets = true;
            this.highlightedIndex = -1;
            this.selectedIndex = -1;
            this.mouseX = -1.0;
            this.mouseY = -1.0;
            this.selectBeforeFrame = 0;
            this.frameNumber = 0;
        }

        // OnKeyDown / OnKeyUp.
        onKey(key: int, scancode: int, action: int, mods: int) {
            if (action == ACTION_PRESS) {
                if (key == KEY_SPACE) {
                    this.drawMeshlets = !this.drawMeshlets;
                    this.selectedIndex = -1;
                    this.highlightedIndex = -1;
                } else if (key == KEY_TAB) {
                    this.selectedIndex = this.highlightedIndex;
                } else if (key == KEY_LEFT_SHIFT || key == KEY_RIGHT_SHIFT) {
                    this.moveCam = true;
                }
                if (!this.moveCam) {
                    this.mainCam.onKey(key, true);
                } else {
                    this.debugCam.onKey(key, true);
                }
                return 1;
            }
            if (action == ACTION_RELEASE) {
                if (key == KEY_LEFT_SHIFT || key == KEY_RIGHT_SHIFT) {
                    this.moveCam = false;
                }
                this.mainCam.onKey(key, false);
                this.debugCam.onKey(key, false);
                return 1;
            }
            return 0;
        }

        onMousePos(x: number, y: number) {
            this.mouseX = x;
            this.mouseY = y;
            return 0;
        }

        // OnUpdate: the cameras; the constants with the culling camera's frustum planes, the
        // instances' constants; then the picking ray cast.
        onAnimate(elapsedSeconds: number) {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
            this.frameNumber++;
            if (this.frameNumber == this.selectBeforeFrame) {
                this.selectedIndex = this.highlightedIndex;
            }
            const elapsed = Math.fround(elapsedSeconds);
            this.mainCam.update(elapsed);
            this.debugCam.update(elapsed);

            const view = this.mainCam.viewMatrix();
            const proj = this.mainCam.projectionMatrix(this.fovY, this.aspectRatio, 1000.0);
            const viewProj = matrixMultiply(view, proj);
            const viewInv = matrixInverse(view);
            const viewPosition = row(viewInv, 3);

            // The culling camera's properties, for its planes.
            const cullView = this.debugCam.viewMatrix();
            const cullWorld = matrixInverse(cullView);
            const cullProj = this.debugCam.projectionMatrix(this.fovY, this.aspectRatio, 300.0);
            const cullPos = row(cullWorld, 3);

            // The planes from the culling camera's view-projection matrix.
            const vp = matrixTranspose(matrixMultiply(cullView, cullProj));
            const r0 = row(vp, 0);
            const r1 = row(vp, 1);
            const r2 = row(vp, 2);
            const r3 = row(vp, 3);
            const planes = [
                planeNormalize(vadd(r3, r0)), // Left
                planeNormalize(vsub(r3, r0)), // Right
                planeNormalize(vadd(r3, r1)), // Bottom
                planeNormalize(vsub(r3, r1)), // Top
                planeNormalize(r2),           // Near
                planeNormalize(vsub(r3, r2)), // Far
            ];

            const c = this.constants;
            const viewT = matrixTranspose(view);
            const viewProjT = matrixTranspose(viewProj);
            for (let i = 0; i < 16; i++) {
                c[i] = viewT[i];
                c[16 + i] = viewProjT[i];
            }
            for (let p = 0; p < 6; p++) {
                for (let i = 0; i < 4; i++) {
                    c[32 + p * 4 + i] = planes[p][i];
                    this.frustumConstants[16 + p * 4 + i] = planes[p][i];
                }
            }
            for (let i = 0; i < 3; i++) {
                c[56 + i] = viewPosition[i];
                c[60 + i] = cullPos[i];
            }
            this.uints[0] = this.highlightedIndex;
            this.uints[1] = this.selectedIndex;
            this.uints[2] = this.drawMeshlets ? 1 : 0;

            // FrustumVisualizer::Update.
            for (let i = 0; i < 16; i++) {
                this.frustumConstants[i] = viewProjT[i];
            }
            this.frustumConstants[40] = PURPLE;
            this.frustumConstants[41] = 0.0;
            this.frustumConstants[42] = PURPLE;
            this.frustumConstants[43] = 1.0;

            // The culling camera's model follows it.
            this.objects[DEBUG_CAMERA].world = cullWorld;

            // The instances' constants.
            for (let o = 0; o < this.objects.length; o++) {
                const world = this.objects[o].world;
                const worldT = matrixTranspose(world);
                const worldInvTrans = matrixTranspose(matrixInverse(matrixTranspose(world)));
                const ic = this.instanceConstants[o];
                for (let i = 0; i < 16; i++) {
                    ic[i] = worldT[i];
                    ic[16 + i] = worldInvTrans[i];
                }
                ic[32] = scaleOf(world);
            }

            // CullDataVisualizer::SetConstants, for the view model.
            const world = this.objects[VIEW_MODEL].world;
            const viewToWorld = matrixTranspose(view);
            const camUp = transformNormal3([0.0, 1.0, 0.0, 0.0], viewToWorld);
            const camForward = transformNormal3([0.0, 0.0, -1.0, 0.0], viewToWorld);
            const worldT = matrixTranspose(world);
            const cd = this.cullDataConstants;
            for (let i = 0; i < 16; i++) {
                cd[i] = worldT[i];
                cd[16 + i] = viewProjT[i];
            }
            // Yellow, alpha 0.3.
            cd[32] = 1.0;
            cd[33] = 1.0;
            cd[34] = 0.0;
            cd[35] = Math.fround(0.3);
            for (let i = 0; i < 4; i++) {
                cd[36 + i] = camUp[i];
            }
            for (let i = 0; i < 3; i++) {
                cd[40 + i] = camForward[i];
            }
            cd[43] = scaleOf(world);

            if (this.drawMeshlets) {
                this.pick(view, proj);
            }
        }

        // Pick: the meshlet of the view model's first mesh whose triangle the ray from the camera
        // through the mouse meets first.
        pick(view: number[], proj: number[]) {
            this.highlightedIndex = -1;
            if (this.mouseX < 0.0) {
                return;
            }
            const obj = this.objects[VIEW_MODEL];
            const mesh = obj.meshes[0];

            // XMVector3Unproject of (x, y, 1) through the viewport and view-projection matrix.
            const ndcX = Math.fround(Math.fround(this.mouseX / Math.fround(this.width * 0.5)) - 1.0);
            const ndcY = Math.fround(1.0 - Math.fround(this.mouseY / Math.fround(this.height * 0.5)));
            const inverseViewProj = matrixInverse(matrixMultiply(view, proj));
            const sampleWS = transformCoord3([ndcX, ndcY, 1.0, 1.0], inverseViewProj);
            const viewPosWS = transform3([0.0, 0.0, 0.0, 0.0], matrixInverse(view));
            const viewDirWS = normalize3(vsub(sampleWS, viewPosWS));

            // The ray in object space.
            const invWorld = matrixInverse(obj.world);
            const dir = normalize3(transformNormal3(viewDirWS, invWorld));
            const org = transformCoord3(viewPosWS, invWorld);

            let minT = 3.402823466e38;
            const v = mesh.vertices;
            for (let i = 0; i < mesh.meshletCount; i++) {
                const cf = mesh.cullFloats;
                const sphere = [cf[i * 6], cf[i * 6 + 1], cf[i * 6 + 2], cf[i * 6 + 3]];
                if (!rayIntersectSphere(org, dir, sphere)) {
                    continue;
                }
                const vertOffset = mesh.meshlets[i * 4 + 1];
                const primCount = mesh.meshlets[i * 4 + 2];
                const primOffset = mesh.meshlets[i * 4 + 3];
                for (let j = 0; j < primCount; j++) {
                    const prim = mesh.primitives[primOffset + j];
                    const v0 = mesh.vertexIndex(vertOffset + (prim & 0x3FF)) * 6;
                    const v1 = mesh.vertexIndex(vertOffset + ((prim >> 10) & 0x3FF)) * 6;
                    const v2 = mesh.vertexIndex(vertOffset + ((prim >> 20) & 0x3FF)) * 6;
                    const t = rayIntersectTriangle(org, dir, [v[v0], v[v0 + 1], v[v0 + 2], 0.0],
                        [v[v1], v[v1 + 1], v[v1 + 2], 0.0], [v[v2], v[v2 + 1], v[v2 + 2], 0.0]);
                    if (t >= 0.0 && t < minT) {
                        minT = t;
                        this.highlightedIndex = i;
                    }
                }
            }
        }

        onBackBufferResizing() {
            if (!this.hasTargets) {
                return;
            }
            this.app.releaseResource(this.meshPipeline);
            this.app.releaseResource(this.frustumPipeline);
            this.app.releaseResource(this.spherePipeline);
            this.app.releaseResource(this.conePipeline);
            this.app.releaseResource(this.framebuffer);
            this.app.releaseResource(this.colorBuffer);
            this.app.releaseResource(this.depthBuffer);
            this.app.clearBindingCache();
            this.hasTargets = false;
        }

        // The sample's back buffer, depth buffer and pipeline states: the meshlets with culling off
        // (to see the backs of culled meshlets), the frustum's lines, the bounding sphere blended
        // over the scene and the normal cone's lines, those two without depth testing.
        createTargets(width: int, height: int) {
            this.colorBuffer = this.app.createRenderTargetTexture(width, height, Format.RGBA8_UNORM, "ColorBuffer");
            this.depthBuffer = this.app.createRenderTargetTexture(width, height, Format.D32, "DepthBuffer");
            this.framebuffer = this.app.createFramebuffer(this.colorBuffer, this.depthBuffer);

            const meshDesc = GraphicsPipelineDesc.createMeshlet(this.meshPipelineAS, this.meshPipelineMS, this.meshPipelinePS);
            meshDesc.addBindingLayout(this.meshLayout);
            meshDesc.setDepthState(1, 1, ComparisonFunc.Less);
            meshDesc.setRasterState(CullMode.None, FillMode.Solid, 0);
            this.meshPipeline = this.app.createMeshletPipelineFromDesc(meshDesc, this.framebuffer);

            const frustumDesc = GraphicsPipelineDesc.createMeshlet(null, this.frustumMS, this.debugPS);
            frustumDesc.addBindingLayout(this.frustumLayout);
            frustumDesc.setPrimitiveType(PrimitiveType.LineList);
            frustumDesc.setDepthState(1, 1, ComparisonFunc.Less);
            frustumDesc.setRasterState(CullMode.Back, FillMode.Solid, 0);
            this.frustumPipeline = this.app.createMeshletPipelineFromDesc(frustumDesc, this.framebuffer);

            const sphereDesc = GraphicsPipelineDesc.createMeshlet(null, this.sphereMS, this.debugPS);
            sphereDesc.addBindingLayout(this.cullDataLayout);
            sphereDesc.setDepthState(0, 0, ComparisonFunc.Less);
            sphereDesc.setRasterState(CullMode.None, FillMode.Solid, 0);
            sphereDesc.setBlendState(1, BlendFactor.SrcAlpha, BlendFactor.InvSrcAlpha, BlendOp.Add,
                BlendFactor.Zero, BlendFactor.One, BlendOp.Max);
            this.spherePipeline = this.app.createMeshletPipelineFromDesc(sphereDesc, this.framebuffer);

            const coneDesc = GraphicsPipelineDesc.createMeshlet(null, this.coneMS, this.debugPS);
            coneDesc.addBindingLayout(this.cullDataLayout);
            coneDesc.setPrimitiveType(PrimitiveType.LineList);
            coneDesc.setDepthState(0, 0, ComparisonFunc.Less);
            coneDesc.setRasterState(CullMode.None, FillMode.Solid, 0);
            this.conePipeline = this.app.createMeshletPipelineFromDesc(coneDesc, this.framebuffer);
            this.hasTargets = true;
        }

        // PopulateCommandList.
        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const commandList = frame.getCommandList();
            if (!this.hasTargets) {
                this.createTargets(frame.getWidth(), frame.getHeight());
            }

            commandList.writeBuffer(this.constantBuffer, Ref(this.constants[0]), CONSTANT_FLOATS * 4);
            commandList.writeBufferAt(this.constantBuffer, HIGHLIGHTED_OFFSET, Ref(this.uints[0]), 4);
            commandList.writeBufferAt(this.constantBuffer, SELECTED_OFFSET, Ref(this.uints[1]), 4);
            commandList.writeBufferAt(this.constantBuffer, DRAW_MESHLETS_OFFSET, Ref(this.uints[2]), 4);
            for (let o = 0; o < this.objects.length; o++) {
                const obj = this.objects[o];
                commandList.writeBuffer(obj.instanceBuffer, Ref(this.instanceConstants[o][0]), INSTANCE_FLOATS * 4);
                this.uints[3] = obj.flags;
                commandList.writeBufferAt(obj.instanceBuffer, FLAGS_OFFSET, Ref(this.uints[3]), 4);
            }
            commandList.writeBuffer(this.frustumBuffer, Ref(this.frustumConstants[0]), FRUSTUM_FLOATS * 4);
            commandList.writeBuffer(this.cullDataBuffer, Ref(this.cullDataConstants[0]), CULL_DATA_FLOATS * 4);

            commandList.clearTextureFloat(this.colorBuffer, CLEAR_R, CLEAR_G, CLEAR_B, 1.0);
            commandList.clearDepth(this.depthBuffer, 1.0);

            // All scene objects with the same pipeline state, a thread per meshlet.
            for (const meshObject of this.objects) {
                const meshes = meshObject.meshes;
                for (const mesh of meshes) {
                    frame.beginMeshDrawToFramebuffer(this.meshPipeline, this.framebuffer);
                    frame.drawAddBindingSet(mesh.bindingSet);
                    frame.drawMeshTasks(Math.floor((mesh.meshletCount + AS_GROUP_SIZE - 1) / AS_GROUP_SIZE));
                }
            }

            // The frustum bounds of the culling camera.
            frame.beginMeshDrawToFramebuffer(this.frustumPipeline, this.framebuffer);
            frame.drawAddBindingSet(this.frustumBindingSet);
            frame.drawMeshTasks(1);

            // The culling data of the selected meshlet, in meshlet viewing mode.
            if (this.drawMeshlets && this.selectedIndex != -1) {
                const mesh = this.objects[VIEW_MODEL].meshes[0];
                this.options[0] = this.selectedIndex;
                this.options[1] = 1;
                frame.beginMeshDrawToFramebuffer(this.spherePipeline, this.framebuffer);
                frame.drawAddBindingSet(mesh.cullDataSet);
                frame.drawMeshTasksWithPushConstants(1, Ref(this.options[0]), OPTIONS_SIZE);
                frame.beginMeshDrawToFramebuffer(this.conePipeline, this.framebuffer);
                frame.drawAddBindingSet(mesh.cullDataSet);
                frame.drawMeshTasksWithPushConstants(1, Ref(this.options[0]), OPTIONS_SIZE);
            }

            this.app.blitTexture(frame, this.colorBuffer);
        }

        // Model::LoadFromFile and UploadGpuResources, for an object: each mesh's buffers for the
        // shaders, its MeshInfo, and its data for picking.
        loadObject(commandList: CommandList, index: int) {
            const path = MEDIA_DIR + MODEL_FILES[index];
            const binaryFile = this.app.loadBinaryFile(path);
            if (binaryFile.isNull()) {
                console.log(`Cannot load ${path} (the sample's model: build with DIRECTX_GRAPHICS_SAMPLES_DIR set)`);
                return false;
            }
            const loaded = MeshletModel.load(binaryFile.getData(), binaryFile.getSize());
            this.app.releaseObject(binaryFile.handle);
            if (loaded.isNull()) {
                return false;
            }
            const model = loaded;

            const instanceBuffer = this.app.createConstantBuffer(INSTANCE_SIZE, "Instance");
            const obj = new SceneObject(instanceBuffer, OBJECT_FLAGS[index], OBJECT_SCALES[index]);
            const ic: f32[] = [];
            for (let i = 0; i < INSTANCE_FLOATS; i++) {
                ic.push(0.0);
            }
            this.instanceConstants.push(ic);

            let ok = true;
            const meshCount = model.getMeshCount();
            for (let i = 0; i < meshCount && ok; i++) {
                // The mesh shader reads the first vertex buffer as positions and normals.
                if (model.getVertexBufferStride(i, 0) != VERTEX_STRIDE) {
                    console.log(`${path}: vertices of another layout than the mesh shader's`);
                    ok = false;
                    break;
                }
                const vertexSize = model.getVertexBufferSize(i, 0);
                const meshletCount = model.getDataCount(i, MeshletModelData.Meshlets);
                const uniqueSize = model.getDataSize(i, MeshletModelData.UniqueVertexIndices);
                const primitiveCount = model.getDataCount(i, MeshletModelData.PrimitiveIndices);

                // The data on the CPU: the unique vertex indices rounded up to whole uints, as the
                // sample's buffer.
                const indexSize = model.getIndexSize(i);
                const vertices = this.app.createStaticShaderBuffer(commandList, model.getVertexBufferData(i, 0),
                    vertexSize, 0, "Vertices");
                const meshlets = this.app.createStaticShaderBuffer(commandList, model.getData(i, MeshletModelData.Meshlets),
                    meshletCount * MESHLET_STRIDE, MESHLET_STRIDE, "Meshlets");
                const uniqueInts = Math.floor((uniqueSize + 3) / 4);
                const primitives = this.app.createStaticShaderBuffer(commandList, model.getData(i, MeshletModelData.PrimitiveIndices),
                    primitiveCount * 4, 4, "PrimitiveIndices");
                const cullData = this.app.createStaticShaderBuffer(commandList, model.getData(i, MeshletModelData.CullData),
                    meshletCount * CULL_DATA_STRIDE, 0, "CullData");

                let unique: int[] = [];
                for (let j = 0; j < uniqueInts; j++) {
                    unique.push(0);
                }
                model.copyData(i, MeshletModelData.UniqueVertexIndices, Ref(unique[0]));
                const uniqueVertexIndices = this.app.createStaticShaderBuffer(commandList, Ref(unique[0]), uniqueInts * 4, 0, "UniqueVertexIndices");

                // MeshInfo: index size, meshlet count, the last meshlet's vertex and primitive counts.
                let meshletInts: int[] = [];
                for (let j = 0; j < meshletCount * 4; j++) {
                    meshletInts.push(0);
                }
                model.copyData(i, MeshletModelData.Meshlets, Ref(meshletInts[0]));
                let meshInfo = [indexSize, meshletCount, meshletInts[(meshletCount - 1) * 4], meshletInts[(meshletCount - 1) * 4 + 2]];
                const meshInfoBuffer = this.app.createConstantBuffer(MESH_INFO_SIZE, "MeshInfo");
                commandList.writeBuffer(meshInfoBuffer, Ref(meshInfo[0]), 16);

                const setDesc = BindingSetDesc.create();
                setDesc.bindEntireConstantBuffer(0, this.constantBuffer);
                setDesc.bindEntireConstantBuffer(1, meshInfoBuffer);
                setDesc.bindEntireConstantBuffer(2, instanceBuffer);
                setDesc.bindRawBufferSRV(0, vertices);
                setDesc.bindStructuredBufferSRV(1, meshlets);
                setDesc.bindRawBufferSRV(2, uniqueVertexIndices);
                setDesc.bindStructuredBufferSRV(3, primitives);
                setDesc.bindRawBufferSRV(4, cullData);
                const mesh = new MeshletMesh(this.app.createBindingSetForLayout(setDesc, this.meshLayout), cullData, meshletCount, indexSize);

                // The culling data visualizer's binding set for the mesh.
                const cullSetDesc = BindingSetDesc.create();
                cullSetDesc.bindEntireConstantBuffer(0, this.cullDataBuffer);
                cullSetDesc.bindPushConstants(1, OPTIONS_SIZE);
                cullSetDesc.bindRawBufferSRV(0, cullData);
                mesh.cullDataSet = this.app.createBindingSetForLayout(cullSetDesc, this.cullDataLayout);

                // What picking reads.
                if (index == VIEW_MODEL && i == 0) {
                    mesh.meshlets = meshletInts;
                    mesh.uniqueIndices = unique;
                    let prims: int[] = [];
                    for (let j = 0; j < primitiveCount; j++) {
                        prims.push(0);
                    }
                    model.copyData(i, MeshletModelData.PrimitiveIndices, Ref(prims[0]));
                    mesh.primitives = prims;
                    let verts: f32[] = [];
                    for (let j = 0; j < vertexSize / 4; j++) {
                        verts.push(0.0);
                    }
                    model.copyVertexBuffer(i, 0, Ref(verts[0]));
                    mesh.vertices = verts;
                    let cull: f32[] = [];
                    for (let j = 0; j < meshletCount * 6; j++) {
                        cull.push(0.0);
                    }
                    model.copyData(i, MeshletModelData.CullData, Ref(cull[0]));
                    mesh.cullFloats = cull;
                }
                obj.meshes.push(mesh);
            }
            model.destroy();
            this.objects.push(obj);
            return ok;
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init() {
            const shader = "meshlet_cull.hlsl";
            const visualizers = "meshlet_cull_visualizers.hlsl";
            this.meshPipelineAS = this.app.createShader(shader, "main_as", ShaderType.Amplification);
            this.meshPipelineMS = this.app.createShader(shader, "main_ms", ShaderType.Mesh);
            this.meshPipelinePS = this.app.createShader(shader, "main_ps", ShaderType.Pixel);
            this.frustumMS = this.app.createShader(visualizers, "frustum_ms", ShaderType.Mesh);
            this.sphereMS = this.app.createShader(visualizers, "sphere_ms", ShaderType.Mesh);
            this.coneMS = this.app.createShader(visualizers, "cone_ms", ShaderType.Mesh);
            this.debugPS = this.app.createShader(visualizers, "debug_ps", ShaderType.Pixel);
            if (!this.meshPipelineAS || !this.meshPipelineMS || !this.meshPipelinePS || !this.frustumMS
                || !this.sphereMS || !this.coneMS || !this.debugPS) {
                return false;
            }

            // The sample's root signatures: CBV(b0), CBV(b1), CBV(b2), SRV(t0) .. SRV(t4); the
            // frustum's CBV(b0); the culling data's CBV(b0), RootConstants(b1, 2), SRV(t0).
            const meshLayoutDesc = BindingLayoutDesc.create();
            meshLayoutDesc.layoutConstantBuffer(0);
            meshLayoutDesc.layoutConstantBuffer(1);
            meshLayoutDesc.layoutConstantBuffer(2);
            meshLayoutDesc.layoutRawBufferSRV(0);
            meshLayoutDesc.layoutStructuredBufferSRV(1);
            meshLayoutDesc.layoutRawBufferSRV(2);
            meshLayoutDesc.layoutStructuredBufferSRV(3);
            meshLayoutDesc.layoutRawBufferSRV(4);
            this.meshLayout = this.app.createBindingLayout(meshLayoutDesc, ShaderType.All);
            const frustumLayoutDesc = BindingLayoutDesc.create();
            frustumLayoutDesc.layoutConstantBuffer(0);
            this.frustumLayout = this.app.createBindingLayout(frustumLayoutDesc, ShaderType.All);
            const cullDataLayoutDesc = BindingLayoutDesc.create();
            cullDataLayoutDesc.layoutConstantBuffer(0);
            cullDataLayoutDesc.layoutPushConstants(1, OPTIONS_SIZE);
            cullDataLayoutDesc.layoutRawBufferSRV(0);
            this.cullDataLayout = this.app.createBindingLayout(cullDataLayoutDesc, ShaderType.All);

            this.constantBuffer = this.app.createConstantBuffer(CONSTANTS_SIZE, "Constants");
            this.frustumBuffer = this.app.createConstantBuffer(FRUSTUM_CONSTANTS_SIZE, "FrustumConstants");
            this.cullDataBuffer = this.app.createConstantBuffer(CULL_DATA_CONSTANTS_SIZE, "CullDataConstants");
            const frustumSetDesc = BindingSetDesc.create();
            frustumSetDesc.bindEntireConstantBuffer(0, this.frustumBuffer);
            this.frustumBindingSet = this.app.createBindingSetForLayout(frustumSetDesc, this.frustumLayout);

            // The sample's cameras: the main one at (0, 15, 40), the culling one at (0, 10, 21).
            this.mainCam.init(0.0, 15.0, 40.0);
            this.mainCam.setMoveSpeed(25.0);
            this.debugCam.init(0.0, 10.0, 21.0);
            this.debugCam.setMoveSpeed(25.0);

            const commandList = this.app.createCommandList();
            commandList.open();
            let ok = true;
            for (let i = 0; i < MODEL_FILES.length && ok; i++) {
                ok = this.loadObject(commandList, i);
            }
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);
            if (!ok) {
                return false;
            }
            // Blitting creates Donut's common passes: before any command list is open.
            this.app.getCommonSampler(CommonSampler.LinearClamp);

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setMousePosCallback(this.onMousePos);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // -test: checks the last frame, with the meshlet under the window's center selected. The
    // background is the clear color at the corners; the selected meshlet keeps its color and the
    // others are desaturated (lerp(color, luminosity + 0.2, 0.8): nearly gray); its bounding sphere
    // is blended yellow over the dragon; the culling camera's frustum is purple lines.
    function checkFrame(app: App, pass: MeshletCullPass) {
        const width = app.getWindowWidth();
        const height = app.getWindowHeight();
        let pixels: int[] = [];
        for (let i = 0; i < width * height; i++) {
            pixels.push(0);
        }
        if (app.readBackBufferRGBA8(Ref(pixels[0]), pixels.length) == 0) {
            return "cannot read the back buffer";
        }
        if (pass.selectedIndex < 0) {
            return "no meshlet under the window's center was picked";
        }
        const background = 0 | (51 << 8) | (102 << 16);
        const corners = [0, width - 1, (height - 1) * width, height * width - 1];
        for (const cornerIndex of corners) {
            const p = pixels[cornerIndex] & 0xFFFFFF;
            if (p != background) {
                return `corner pixel ${cornerIndex} is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not the clear color`;
            }
        }

        // Saturated pixels (the selected meshlet's, the frustum's purple, the sphere's yellow) and
        // gray ones (the desaturated meshlets).
        let covered = 0;
        let gray = 0;
        let purple = 0;
        let yellow = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i] & 0xFFFFFF;
            if (p == background) {
                continue;
            }
            covered++;
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            let lo = r;
            let hi = r;
            if (g < lo) {
                lo = g;
            }
            if (b < lo) {
                lo = b;
            }
            if (g > hi) {
                hi = g;
            }
            if (b > hi) {
                hi = b;
            }
            if (hi - lo < hi / 4 + 4) {
                gray++;
            }
            if (r == 128 && g == 0 && b == 128) {
                purple++;
            }
            // Yellow at 30% over the dragon's dark grays.
            if (r > b + 40 && g > b + 40) {
                yellow++;
            }
        }
        console.log(`Covered ${covered}, gray ${gray}, frustum ${purple}, yellow ${yellow}, selected meshlet ${pass.selectedIndex}`);
        if (covered < width * height / 20) {
            return `only ${covered} pixels covered`;
        }
        if (gray < covered / 2) {
            return `the other meshlets aren't desaturated: ${gray} gray pixels of ${covered}`;
        }
        if (purple < 200) {
            return `no frustum lines: ${purple} purple pixels`;
        }
        if (yellow < 200) {
            return `no bounding sphere: ${yellow} yellow pixels`;
        }
        return "";
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("meshlet_cull");

        // -test [-testOutput <file>]: render a few frames without a window, the meshlet under the
        // window's center selected, and check the last one (see checkFrame).
        const args = new Args(argc, argv, TEST_FRAMES);
        args.parseArgs();

        // The sample's window, with UNORM back buffers, as the sample's R8G8B8A8_UNORM.
        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, AppOptions.UnormBackBuffer | args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        if (app.isFeatureSupported(Feature.Meshlets) == 0) {
            app.destroy();
            return unsupported(args.test, "The graphics device has no mesh shaders");
        }

        const pass = new MeshletCullPass(app);
        if (!pass.init()) {
            app.destroy();
            return 1;
        }
        if (args.test) {
            pass.mouseX = 640.0;
            pass.mouseY = 360.0;
            pass.selectBeforeFrame = 2;
        }

        const input = new InputPass(app.handle);

        app.run();
        let result = 0;
        if (args.test) {
            result =app.finishTest(checkFrame(app, pass));
        }
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return MeshletCull.main(argc, argv);
}

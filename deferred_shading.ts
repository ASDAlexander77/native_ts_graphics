/// <reference path="donut_interop.d.ts" />

// GLFW values, as passed to the keyboard callback.
const KEY_ESCAPE = 256;
const ACTION_PRESS = 1;

const WINDOW_TITLE = "Donut Example: Deferred Shading";

// --- Model ------------------------------------------------------------------------------------

const VERTEX_COUNT = 24;
const INDEX_COUNT = 36;

// `let`, not `const`: tslang takes the address of the array's storage only for non-const arrays.
let g_Positions: f32[] = [
    -0.5,  0.5, -0.5, // front face
     0.5, -0.5, -0.5,
    -0.5, -0.5, -0.5,
     0.5,  0.5, -0.5,

     0.5, -0.5, -0.5, // right side face
     0.5,  0.5,  0.5,
     0.5, -0.5,  0.5,
     0.5,  0.5, -0.5,

    -0.5,  0.5,  0.5, // left side face
    -0.5, -0.5, -0.5,
    -0.5, -0.5,  0.5,
    -0.5,  0.5, -0.5,

     0.5,  0.5,  0.5, // back face
    -0.5, -0.5,  0.5,
     0.5, -0.5,  0.5,
    -0.5,  0.5,  0.5,

    -0.5,  0.5, -0.5, // top face
     0.5,  0.5,  0.5,
     0.5,  0.5, -0.5,
    -0.5,  0.5,  0.5,

     0.5, -0.5,  0.5, // bottom face
    -0.5, -0.5, -0.5,
     0.5, -0.5, -0.5,
    -0.5, -0.5,  0.5,
];

let g_TexCoords: f32[] = [
    0.0, 0.0, // front face
    1.0, 1.0,
    0.0, 1.0,
    1.0, 0.0,

    0.0, 1.0, // right side face
    1.0, 0.0,
    1.0, 1.0,
    0.0, 0.0,

    0.0, 0.0, // left side face
    1.0, 1.0,
    0.0, 1.0,
    1.0, 0.0,

    0.0, 0.0, // back face
    1.0, 1.0,
    0.0, 1.0,
    1.0, 0.0,

    0.0, 1.0, // top face
    1.0, 0.0,
    1.0, 1.0,
    0.0, 0.0,

    1.0, 1.0, // bottom face
    0.0, 0.0,
    1.0, 0.0,
    0.0, 1.0,
];

// The normal (x, y, z) and tangent (x, y, z, w) shared by the four vertices of each face, in
// the order of the faces above; packed per vertex into g_Normals / g_Tangents by packFaceVectors.
const g_FaceNormals: number[] = [
     0.0,  0.0, -1.0, // front face
     1.0,  0.0,  0.0, // right side face
    -1.0,  0.0,  0.0, // left side face
     0.0,  0.0,  1.0, // back face
     0.0,  1.0,  0.0, // top face
     0.0, -1.0,  0.0, // bottom face
];

const g_FaceTangents: number[] = [
     1.0,  0.0,  0.0, 1.0, // front face
     0.0,  0.0,  1.0, 1.0, // right side face
     0.0,  0.0, -1.0, 1.0, // left side face
    -1.0,  0.0,  0.0, 1.0, // back face
     1.0,  0.0,  0.0, 1.0, // top face
     1.0,  0.0,  0.0, 1.0, // bottom face
];

let g_Normals: int[] = [];
let g_Tangents: int[] = [];

let g_Indices: int[] = [
     0,  1,  2,   0,  3,  1, // front face
     4,  5,  6,   4,  7,  5, // left face
     8,  9, 10,   8, 11,  9, // right face
    12, 13, 14,  12, 15, 13, // back face
    16, 17, 18,  16, 19, 17, // top face
    20, 21, 22,  20, 23, 21, // bottom face
];

// donut::math::vectorToSnorm8(float4(x, y, z, w)): each component scaled by 127 / |xyz|, one
// byte each.
function vectorToSnorm8(x: number, y: number, z: number, w: number): int {
    const scale = 127.0 / Math.sqrt(x * x + y * y + z * z);
    const xi: int = Math.trunc(x * scale);
    const yi: int = Math.trunc(y * scale);
    const zi: int = Math.trunc(z * scale);
    const wi: int = Math.trunc(w * scale);
    return (xi & 0xff) | ((yi & 0xff) << 8) | ((zi & 0xff) << 16) | ((wi & 0xff) << 24);
}

function packFaceVectors(): void {
    for (let vertex = 0; vertex < VERTEX_COUNT; vertex++) {
        const face = Math.floor(vertex / 4);
        g_Normals.push(vectorToSnorm8(g_FaceNormals[face * 3], g_FaceNormals[face * 3 + 1], g_FaceNormals[face * 3 + 2], 0.0));
        g_Tangents.push(vectorToSnorm8(g_FaceTangents[face * 4], g_FaceTangents[face * 4 + 1], g_FaceTangents[face * 4 + 2],
            g_FaceTangents[face * 4 + 3]));
    }
}

// --- Math -------------------------------------------------------------------------------------
// The donut::math functions the C++ sample uses, on row-major 4x4 matrices (16 numbers) with
// Donut's row-vector convention: `mul(a, b)` applies a, then b.

function radians(degrees: number): number {
    return degrees * Math.PI / 180.0;
}

function mul(a: number[], b: number[]): number[] {
    // `let`: tslang's push needs a non-const array.
    let r: number[] = [];
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            let sum = 0.0;
            for (let k = 0; k < 4; k++) {
                sum += a[i * 4 + k] * b[k * 4 + j];
            }
            r.push(sum);
        }
    }
    return r;
}

// math::yawPitchRoll(yaw, pitch, roll).
function yawPitchRoll(yaw: number, pitch: number, roll: number): number[] {
    const sh = Math.sin(yaw);
    const ch = Math.cos(yaw);
    const sp = Math.sin(pitch);
    const cp = Math.cos(pitch);
    const sb = Math.sin(roll);
    const cb = Math.cos(roll);
    return [
        ch * cb + sh * sp * sb,  sb * cp, -sh * cb + ch * sp * sb, 0.0,
        -ch * sb + sh * sp * cb, cb * cp, sb * sh + ch * sp * cb,  0.0,
        sh * cp,                 -sp,     ch * cp,                 0.0,
        0.0,                     0.0,     0.0,                     1.0,
    ];
}

// math::translation(float3(x, y, z)).
function translation(x: number, y: number, z: number): number[] {
    return [
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        x,   y,   z,   1.0,
    ];
}

// math::perspProjD3DStyle(verticalFOV, aspect, zNear, zFar).
function perspProjD3DStyle(verticalFOV: number, aspect: number, zNear: number, zFar: number): number[] {
    const yScale = 1.0 / Math.tan(0.5 * verticalFOV);
    const xScale = yScale / aspect;
    const zScale = 1.0 / (zFar - zNear);
    return [
        xScale, 0.0,    0.0,                    0.0,
        0.0,    yScale, 0.0,                    0.0,
        0.0,    0.0,    zFar * zScale,          1.0,
        0.0,    0.0,    -zNear * zFar * zScale, 0.0,
    ];
}

// --- Scene ------------------------------------------------------------------------------------

// A textured cube lit by the sun, built in code: the sample's SimpleScene.
class SimpleScene {
    public sceneGraph: Opaque;
    public meshNode: Opaque;

    init(app: Opaque): boolean {
        packFaceVectors();

        const commandList = Donut_CreateCommandList(app);
        Donut_OpenCommandList(commandList);

        const material = Donut_CreateTexturedMaterial(app, commandList, "CubeMaterial", "media/nvidia-logo.png", 1);
        let mesh: Opaque | null = null;
        if (material) {
            mesh = Donut_CreateMesh(app, commandList, "CubeMesh", material,
                Ref(g_Positions[0]), Ref(g_TexCoords[0]), Ref(g_Normals[0]), Ref(g_Tangents[0]), VERTEX_COUNT,
                Ref(g_Indices[0]), INDEX_COUNT);
        }

        Donut_CloseCommandList(commandList);
        Donut_ExecuteCommandList(app, commandList);
        Donut_ReleaseResource(app, commandList);

        if (!mesh) {
            console.log("Couldn't load the texture");
            return false;
        }

        this.sceneGraph = Donut_CreateSceneGraph(app);
        this.meshNode = Donut_AddMeshNode(app, this.sceneGraph, null, mesh, "CubeNode");
        Donut_AddDirectionalLight(this.sceneGraph, this.meshNode, "Sun", 0.1, -1.0, 0.2, 0.53, 1.0);

        Donut_RefreshSceneGraph(app, this.sceneGraph);

        Donut_PrintSceneGraph(this.sceneGraph);

        return true;
    }
}

// --- Passes -----------------------------------------------------------------------------------

// Port of Donut-Samples' deferred_shading.cpp: draws the cube into a G-buffer, lights it with
// Donut's deferred lighting pass and shows the result.
class DeferredShadingPass {
    private app: Opaque;
    private scene: SimpleScene;
    private deferredLightingPass: Opaque;
    private view: Opaque;
    // Created on the first frame, and again when the frame size changes.
    private renderTargets: Opaque | null;
    private renderTargetsWidth: int;
    private renderTargetsHeight: int;
    private gbufferPass: Opaque | null;
    private rotation: number;
    // Passed to Donut_SetPlanarView, 16 floats each.
    private viewMatrix: f32[];
    private projMatrix: f32[];

    constructor(app: Opaque) {
        this.app = app;
        this.scene = new SimpleScene();
        this.renderTargets = null;
        this.renderTargetsWidth = 0;
        this.renderTargetsHeight = 0;
        this.gbufferPass = null;
        this.rotation = 0.0;
        this.viewMatrix = [];
        this.projMatrix = [];
        for (let i = 0; i < 16; i++) {
            this.viewMatrix.push(0.0);
            this.projMatrix.push(0.0);
        }
    }

    setupView(width: int, height: int): void {
        const viewMatrix = mul(mul(
            yawPitchRoll(this.rotation, 0.0, 0.0),
            yawPitchRoll(0.0, radians(-30.0), 0.0)),
            translation(0.0, 0.0, 2.0));

        const projection = perspProjD3DStyle(radians(60.0), width / height, 0.1, 10.0);

        for (let i = 0; i < 16; i++) {
            this.viewMatrix[i] = viewMatrix[i];
            this.projMatrix[i] = projection[i];
        }

        Donut_SetPlanarView(this.view, Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), width, height);
    }

    createRenderTargets(width: int, height: int): Opaque {
        const oldTargets = this.renderTargets;
        if (oldTargets) {
            Donut_ReleaseObject(this.app, oldTargets);
            this.renderTargets = null;
        }
        Donut_ClearBindingCache(this.app);
        Donut_ResetDeferredLightingBindingCache(this.deferredLightingPass);

        const gbufferPass = this.gbufferPass;
        if (gbufferPass) {
            Donut_ReleaseObject(this.app, gbufferPass);
            this.gbufferPass = null;
        }

        const targets = Donut_CreateGBufferTargets(this.app, width, height, 0);
        this.renderTargets = targets;
        this.renderTargetsWidth = width;
        this.renderTargetsHeight = height;
        return targets;
    }

    onAnimate(seconds: number): void {
        this.rotation += seconds * 1.1;
        Donut_SetInformativeWindowTitle(this.app, WINDOW_TITLE);
    }

    onRender(frame: Opaque): void {
        const width = Donut_GetFrameWidth(frame);
        const height = Donut_GetFrameHeight(frame);

        let targets = this.renderTargets;
        if (!targets || this.renderTargetsWidth != width || this.renderTargetsHeight != height) {
            targets = this.createRenderTargets(width, height);
        }

        this.setupView(width, height);

        let gbufferPass = this.gbufferPass;
        if (!gbufferPass) {
            gbufferPass = Donut_CreateGBufferFillPass(this.app);
            this.gbufferPass = gbufferPass;
        }

        Donut_ClearGBuffer(frame, targets);

        Donut_RenderMeshNodeToGBuffer(frame, gbufferPass, this.view, targets, this.scene.meshNode);

        const ambientColorTop = 0.2;
        Donut_RenderDeferredLighting(frame, this.deferredLightingPass, this.view, targets, this.scene.sceneGraph,
            ambientColorTop, ambientColorTop, ambientColorTop,
            ambientColorTop * 0.3, ambientColorTop * 0.4, ambientColorTop * 0.3);

        Donut_BlitTexture(this.app, frame, Donut_GetGBufferShadedColor(targets));
    }

    // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
    init(): boolean {
        this.deferredLightingPass = Donut_CreateDeferredLightingPass(this.app);
        this.view = Donut_CreatePlanarView(this.app);

        if (!this.scene.init(this.app)) {
            return false;
        }

        const pass = Donut_AddPass(this.app);
        Donut_SetAnimateCallback(pass, this.onAnimate);
        Donut_SetRenderCallback(pass, this.onRender);
        return true;
    }
}

class InputPass {
    private app: Opaque;

    constructor(app: Opaque) {
        this.app = app;

        const pass = Donut_AddPass(app);
        Donut_SetKeyboardCallback(pass, this.onKey);
    }

    onKey(key: int, scancode: int, action: int, mods: int): int {
        if (key == KEY_ESCAPE && action == ACTION_PRESS) {
            Donut_CloseWindow(this.app);
            return 1;
        }

        return 0;
    }
}

function main(argc: int, argv: Opaque): int {

    const app = Donut_CreateApp(argc, argv, WINDOW_TITLE, 1280, 720);
    if (!app) {
        console.log("Cannot initialize a graphics device with the requested parameters");
        return 1;
    }

    console.log(`Renderer: ${Donut_GetRendererString(app)}`);

    const deferredShading = new DeferredShadingPass(app);
    if (!deferredShading.init()) {
        Donut_DestroyApp(app);
        return 1;
    }

    const input = new InputPass(app);

    Donut_RunApp(app);
    Donut_DestroyApp(app);
    return 0;
}

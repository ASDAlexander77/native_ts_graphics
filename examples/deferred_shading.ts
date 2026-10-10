// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace DeferredShading {
    const WINDOW_TITLE = "Donut Example: Deferred Shading";

    // --- Model --------------------------------------------------------------------------------

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

    // --- Math ---------------------------------------------------------------------------------
    // The donut::math functions the C++ sample uses, on row-major 4x4 matrices (16 numbers) with
    // Donut's row-vector convention: `mul(a, b)` applies a, then b.

    // math::radians(float): in float32, as every use in the sample is.
    function radians(degrees: number): number {
        return Math.fround(Math.fround(degrees) * Math.fround(Math.fround(Math.PI) / 180.0));
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

    // --- Scene --------------------------------------------------------------------------------

    // A textured cube lit by the sun, built in code: the sample's SimpleScene.
    class SimpleScene {
        public sceneGraph: SceneGraph;
        public meshNode: Node;

        init(app: App): boolean {
            packFaceVectors();

            const commandList = app.createCommandList();
            commandList.open();

            const material = app.createTexturedMaterial(commandList, "CubeMaterial", "media/nvidia-logo.png", 1);
            let mesh: Opaque | null = null;
            if (!material.isNull()) {
                mesh = app.createMesh(commandList, "CubeMesh", material,
                    Ref(g_Positions[0]), Ref(g_TexCoords[0]), Ref(g_Normals[0]), Ref(g_Tangents[0]), VERTEX_COUNT,
                    Ref(g_Indices[0]), INDEX_COUNT);
            }

            commandList.close();
            app.executeCommandList(commandList);
            app.releaseResource(commandList.handle);

            if (!mesh) {
                console.log("Couldn't load the texture");
                return false;
            }

            this.sceneGraph = app.createSceneGraph();
            this.meshNode = app.addMeshNode(this.sceneGraph, null, mesh, "CubeNode");
            this.sceneGraph.addDirectionalLight(this.meshNode, "Sun", 0.1, -1.0, 0.2, 0.53, 1.0);

            app.refreshSceneGraph(this.sceneGraph);

            this.sceneGraph.print();

            return true;
        }
    }

    // --- Passes -------------------------------------------------------------------------------

    // Port of Donut-Samples' deferred_shading.cpp: draws the cube into a G-buffer, lights it with
    // Donut's deferred lighting pass and shows the result.
    class DeferredShadingPass {
        private app: App;
        private scene: SimpleScene;
        private deferredLightingPass: DeferredLightingPass;
        private view: View;
        // Created on the first frame, and again when the frame size changes.
        private renderTargets: GBufferTargets;
        private renderTargetsWidth: int;
        private renderTargetsHeight: int;
        private gbufferPass: GBufferFillPass;
        private rotation: number;
        // Passed to View.setPlanarView, 16 floats each.
        private viewMatrix: f32[];
        private projMatrix: f32[];

        constructor(app: App) {
            this.app = app;
            this.scene = new SimpleScene();
            this.renderTargets = new GBufferTargets(null);
            this.renderTargetsWidth = 0;
            this.renderTargetsHeight = 0;
            this.gbufferPass = new GBufferFillPass(null);
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

            this.view.setPlanarView(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), width, height);
        }

        createRenderTargets(width: int, height: int): GBufferTargets {
            const oldTargets = this.renderTargets;
            if (!oldTargets.isNull()) {
                this.app.releaseObject(oldTargets.handle);
                this.renderTargets = new GBufferTargets(null);
            }
            this.app.clearBindingCache();
            this.deferredLightingPass.resetBindingCache();

            const gbufferPass = this.gbufferPass;
            if (!gbufferPass.isNull()) {
                this.app.releaseObject(gbufferPass.handle);
                this.gbufferPass = new GBufferFillPass(null);
            }

            const targets = this.app.createGBufferTargets(width, height, 0);
            this.renderTargets = targets;
            this.renderTargetsWidth = width;
            this.renderTargetsHeight = height;
            return targets;
        }

        onAnimate(seconds: number): void {
            this.rotation += seconds * 1.1;
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        onRender(frameHandle: Opaque): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();

            let targets = this.renderTargets;
            if (targets.isNull() || this.renderTargetsWidth != width || this.renderTargetsHeight != height) {
                targets = this.createRenderTargets(width, height);
            }

            this.setupView(width, height);

            let gbufferPass = this.gbufferPass;
            if (gbufferPass.isNull()) {
                gbufferPass = this.app.createGBufferFillPass();
                this.gbufferPass = gbufferPass;
            }

            frame.clearGBuffer(targets);

            frame.renderMeshNodeToGBuffer(gbufferPass, this.view, targets, this.scene.meshNode);

            const ambientColorTop = 0.2;
            frame.renderDeferredLighting(this.deferredLightingPass, this.view, targets, this.scene.sceneGraph,
                ambientColorTop, ambientColorTop, ambientColorTop,
                ambientColorTop * 0.3, ambientColorTop * 0.4, ambientColorTop * 0.3);

            this.app.blitTexture(frame, targets.getShadedColor());
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            this.deferredLightingPass = this.app.createDeferredLightingPass();
            this.view = this.app.createPlanarView();

            if (!this.scene.init(this.app)) {
                return false;
            }

            const pass = this.app.addPass();
            pass.setAnimateCallback(this.onAnimate);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("deferred_shading");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        let options = AppOptions.None;
        for (let i = 1; i < argc; i++) {
            if (Donut_GetArg(argv, i) == "-debug") {
                options = AppOptions.DebugRuntime;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const deferredShading = new DeferredShadingPass(app);
        if (!deferredShading.init()) {
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
    return DeferredShading.main(argc, argv);
}

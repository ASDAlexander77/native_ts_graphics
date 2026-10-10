// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace MouseCursor {
    const WINDOW_TITLE = "Donut Example: Mouse Cursor";
    const MEDIA_DIR = "media/mouse_cursor/";
    const FONT_PATH = "media/fonts/OpenSans/OpenSans-Regular.ttf";

    // The sample's sprite fonts (SegoeUI_34, _24 and _22) as OpenSans sizes giving its strings'
    // widths: 42.3, 30.9 and 27.7 pixel ems, times 1.3618 as ImGui sizes a font by its ascent +
    // descent (OpenSans: (2189 + 600) / 2048 em); and the sprite fonts' line spacings.
    const TITLE_FONT_SIZE = 57.6;
    const SUBTITLE_FONT_SIZE = 42.1;
    const TILE_FONT_SIZE = 37.7;
    const TITLE_LINE_SPACING = 60.3;
    const SUBTITLE_LINE_SPACING = 42.6;
    const TILE_LINE_SPACING = 39.0;

    // DirectX::Colors::CornflowerBlue, cleared in the UNORM back buffer as the sample's.
    const CORNFLOWER_BLUE = [0.392156899, 0.584313750, 0.929411829];

    const ROTATION_GAIN = 0.004; // sensitivity adjustment
    const PI = 3.14159274;

    // The sample's modes.
    const ABSOLUTE_MOUSE = 0;
    const RELATIVE_MOUSE = 1;
    const CLIPCURSOR_MOUSE = 2;

    // SpriteConstants (mouse_cursor.hlsl): rect, target size, padding, color.
    const SPRITE_FLOATS = 12;
    // Parameters (mouse_cursor.hlsl): DiffuseColor, EmissiveColor, SpecularColor and
    // SpecularPower, the three lights' directions, diffuse and specular colors, EyePosition,
    // World, WorldInverseTranspose, WorldViewProj.
    const PARAMETERS_FLOATS = 100;
    const PARAMETERS_EMISSIVE = 4;
    const PARAMETERS_SPECULAR = 8;
    const PARAMETERS_LIGHTS = 12;
    const PARAMETERS_EYE = 48;
    const PARAMETERS_WORLD = 52;
    const PARAMETERS_WORLD_INVERSE_TRANSPOSE = 68;
    const PARAMETERS_WORLD_VIEW_PROJ = 84;

    // DirectXTK's EffectLights::EnableDefaultLighting.
    const DEFAULT_DIRECTIONS = [
        -0.5265408, -0.5735765, -0.6275069,
        0.7198464, 0.3420201, 0.6040227,
        0.4545195, -0.7660444, 0.4545195,
    ];
    const DEFAULT_DIFFUSE = [
        1.0000000, 0.9607844, 0.8078432,
        0.9647059, 0.7607844, 0.4078432,
        0.3231373, 0.3607844, 0.3937255,
    ];
    const DEFAULT_SPECULAR = [
        1.0000000, 0.9607844, 0.8078432,
        0.0000000, 0.0000000, 0.0000000,
        0.3231373, 0.3607844, 0.3937255,
    ];
    const DEFAULT_AMBIENT = [0.05333332, 0.09882354, 0.1819608];

    // GLFW values.
    const KEY_ESCAPE = 256;
    const ACTION_PRESS = 1;

    // --- Math (DirectXMath's layout: 4 x 4 matrices by rows, for row vectors) ----------------


    function f(x: number): number {
        return Math.fround(x);
    }

    // std::max and std::min. (tslang's Math.max starts from Number.MIN_VALUE, the smallest
    // positive number: it gives that for negative arguments.)
    function maxf(a: number, b: number): number {
        return a > b ? a : b;
    }

    function minf(a: number, b: number): number {
        return a < b ? a : b;
    }

    function identity(): number[] {
        return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
    }

    function multiply(a: number[], b: number[]): number[] {
        let result: number[] = [];
        for (let row = 0; row < 4; row++) {
            for (let column = 0; column < 4; column++) {
                let sum = 0.0;
                for (let k = 0; k < 4; k++) {
                    sum += a[row * 4 + k] * b[k * 4 + column];
                }
                result.push(f(sum));
            }
        }
        return result;
    }

    function transpose(a: number[]): number[] {
        let result: number[] = [];
        for (let row = 0; row < 4; row++) {
            for (let column = 0; column < 4; column++) {
                result.push(a[column * 4 + row]);
            }
        }
        return result;
    }

    function inverse(m: number[]): number[] {
        const a00 = m[0]; const a01 = m[1]; const a02 = m[2]; const a03 = m[3];
        const a10 = m[4]; const a11 = m[5]; const a12 = m[6]; const a13 = m[7];
        const a20 = m[8]; const a21 = m[9]; const a22 = m[10]; const a23 = m[11];
        const a30 = m[12]; const a31 = m[13]; const a32 = m[14]; const a33 = m[15];
        const b00 = a00 * a11 - a01 * a10;
        const b01 = a00 * a12 - a02 * a10;
        const b02 = a00 * a13 - a03 * a10;
        const b03 = a01 * a12 - a02 * a11;
        const b04 = a01 * a13 - a03 * a11;
        const b05 = a02 * a13 - a03 * a12;
        const b06 = a20 * a31 - a21 * a30;
        const b07 = a20 * a32 - a22 * a30;
        const b08 = a20 * a33 - a23 * a30;
        const b09 = a21 * a32 - a22 * a31;
        const b10 = a21 * a33 - a23 * a31;
        const b11 = a22 * a33 - a23 * a32;
        const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
        const invDet = 1.0 / det;
        return [
            f((a11 * b11 - a12 * b10 + a13 * b09) * invDet),
            f((a02 * b10 - a01 * b11 - a03 * b09) * invDet),
            f((a31 * b05 - a32 * b04 + a33 * b03) * invDet),
            f((a22 * b04 - a21 * b05 - a23 * b03) * invDet),
            f((a12 * b08 - a10 * b11 - a13 * b07) * invDet),
            f((a00 * b11 - a02 * b08 + a03 * b07) * invDet),
            f((a32 * b02 - a30 * b05 - a33 * b01) * invDet),
            f((a20 * b05 - a22 * b02 + a23 * b01) * invDet),
            f((a10 * b10 - a11 * b08 + a13 * b06) * invDet),
            f((a01 * b08 - a00 * b10 - a03 * b06) * invDet),
            f((a30 * b04 - a31 * b02 + a33 * b00) * invDet),
            f((a21 * b02 - a20 * b04 - a23 * b00) * invDet),
            f((a11 * b07 - a10 * b09 - a12 * b06) * invDet),
            f((a00 * b09 - a01 * b07 + a02 * b06) * invDet),
            f((a31 * b01 - a30 * b03 - a32 * b00) * invDet),
            f((a20 * b03 - a21 * b01 + a22 * b00) * invDet),
        ];
    }

    // XMMatrixRotationX.
    function rotationX(angle: number): number[] {
        const c = f(Math.cos(angle));
        const s = f(Math.sin(angle));
        return [1.0, 0.0, 0.0, 0.0, 0.0, c, s, 0.0, 0.0, -s, c, 0.0, 0.0, 0.0, 0.0, 1.0];
    }

    // XMMatrixRotationY.
    function rotationY(angle: number): number[] {
        const c = f(Math.cos(angle));
        const s = f(Math.sin(angle));
        return [c, 0.0, -s, 0.0, 0.0, 1.0, 0.0, 0.0, s, 0.0, c, 0.0, 0.0, 0.0, 0.0, 1.0];
    }

    function normalize3(v: number[]): number[] {
        const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        return [f(v[0] / length), f(v[1] / length), f(v[2] / length)];
    }

    function cross3(a: number[], b: number[]): number[] {
        return [f(a[1] * b[2] - a[2] * b[1]), f(a[2] * b[0] - a[0] * b[2]), f(a[0] * b[1] - a[1] * b[0])];
    }

    function dot3(a: number[], b: number[]): number {
        return f(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
    }

    // XMMatrixLookToLH.
    function lookToLH(eye: number[], direction: number[], up: number[]): number[] {
        const r2 = normalize3(direction);
        const r0 = normalize3(cross3(up, r2));
        const r1 = cross3(r2, r0);
        const negEye = [-eye[0], -eye[1], -eye[2]];
        return [
            r0[0], r1[0], r2[0], 0.0,
            r0[1], r1[1], r2[1], 0.0,
            r0[2], r1[2], r2[2], 0.0,
            dot3(r0, negEye), dot3(r1, negEye), dot3(r2, negEye), 1.0,
        ];
    }

    // SimpleMath's Matrix::CreateLookAt: XMMatrixLookAtRH (XMMatrixLookToLH along eye - target).
    function lookAtRH(eye: number[], target: number[], up: number[]): number[] {
        return lookToLH(eye, [f(eye[0] - target[0]), f(eye[1] - target[1]), f(eye[2] - target[2])], up);
    }

    // XMMatrixPerspectiveFovLH.
    function perspectiveFovLH(fovY: number, aspect: number, nearZ: number, farZ: number): number[] {
        const height = f(Math.cos(0.5 * fovY) / Math.sin(0.5 * fovY));
        const width = f(height / aspect);
        const range = f(farZ / (farZ - nearZ));
        return [
            width, 0.0, 0.0, 0.0,
            0.0, height, 0.0, 0.0,
            0.0, 0.0, range, 1.0,
            0.0, 0.0, f(-range * nearZ), 0.0,
        ];
    }

    // Whether the camera may go to eye (the RTS map's bounds).
    function inBounds(eye: number[]): boolean {
        return eye[2] < -1.0 * eye[0] + 400.0 && eye[2] < eye[0] + 800.0
            && eye[2] > -1.0 * eye[0] - 300.0 && eye[2] > eye[0] - 800.0;
    }

    // Whether (x, y) is inside a tile (left, top, right, bottom), its edges excluded.
    function inTile(tile: int[], x: number, y: number): boolean {
        return x < tile[2] && x > tile[0] && y > tile[1] && y < tile[3];
    }

    // --- Models -------------------------------------------------------------------------------

    // A SDKMESH model as DirectXTK's Model::CreateFromSDKMESH makes it (core/sdkmesh.cpp parses the
    // file): its vertex and index buffers, its mesh parts (one per subset), and per material the
    // effect's diffuse color, specular color and power, emissive color, and textures (the diffuse texture; the
    // specular texture, which is DualTextureEffect's second texture).
    class Model {
        vertexBuffers: BufferHandle[];
        indexBuffers: BufferHandle[];
        index32: boolean[];
        partVertexBuffers: int[];
        partIndexBuffers: int[];
        partMaterials: int[];
        partIndexCounts: int[];
        partStartIndices: int[];
        partVertexOffsets: int[];
        materialColors: number[];
        materialSpecular: number[];
        materialEmissive: number[];
        materialTextures: TextureHandle[];
        materialTextures2: TextureHandle[];
        // Per material, the binding set (the parameters, its textures, the sampler).
        materialBindingSets: BindingSet[];

        constructor() {
            this.vertexBuffers = [];
            this.indexBuffers = [];
            this.index32 = [];
            this.partVertexBuffers = [];
            this.partIndexBuffers = [];
            this.partMaterials = [];
            this.partIndexCounts = [];
            this.partStartIndices = [];
            this.partVertexOffsets = [];
            this.materialColors = [];
            this.materialSpecular = [];
            this.materialEmissive = [];
            this.materialTextures = [];
            this.materialTextures2 = [];
            this.materialBindingSets = [];
        }

        // The file's buffers uploaded by an open command list, its materials' textures loaded
        // (DDS files as they are). dualTexture: the materials' specular textures too, and the
        // vertices must have two texture coordinates. False (after printing why) on failure.
        load(app: App, commandList: CommandList, file: string, stride: int, dualTexture: boolean): boolean {
            const binaryFile = app.loadBinaryFile(MEDIA_DIR + file);
            if (binaryFile.isNull()) {
                console.log(`Cannot load ${file}: set XBOX_ATG_SAMPLES_DIR when configuring`);
                return false;
            }
            const loaded = Donut_LoadSdkMesh(binaryFile.getData(), binaryFile.getSize());
            if (!loaded) {
                app.releaseObject(binaryFile.handle);
                console.log(`${file}: not a SDKMESH file`);
                return false;
            }
            const mesh = loaded as Opaque;

            // Position, normal, texture coordinates (and a second set for the dual texture effect).
            let ok = true;
            for (let i = 0; i < Donut_GetSdkMeshVertexBufferCount(mesh); i++) {
                let layoutOk = Donut_GetSdkMeshVertexBufferStride(mesh, i) == stride
                    && Donut_GetSdkMeshVertexElementOffset(mesh, i, 3, 0) == 12 && Donut_GetSdkMeshVertexElementOffset(mesh, i, 5, 0) == 24;
                if (dualTexture && Donut_GetSdkMeshVertexElementOffset(mesh, i, 5, 1) != 32) {
                    layoutOk = false;
                }
                if (!layoutOk) {
                    console.log(`${file}: unexpected vertex layout`);
                    ok = false;
                }
                this.vertexBuffers.push(app.createStaticVertexBuffer(commandList, Donut_GetSdkMeshVertexBufferData(mesh, i),
                    Donut_GetSdkMeshVertexBufferSize(mesh, i), file));
            }
            for (let i = 0; i < Donut_GetSdkMeshIndexBufferCount(mesh); i++) {
                this.indexBuffers.push(app.createStaticIndexBuffer(commandList, Donut_GetSdkMeshIndexBufferData(mesh, i),
                    Donut_GetSdkMeshIndexBufferSize(mesh, i), file));
                this.index32.push(Donut_IsSdkMeshIndexBuffer32Bit(mesh, i) != 0);
            }

            // LoadMaterial: a material whose ambient and diffuse colors are all zero is white; the
            // specular color only with a positive power.
            let colors: f32[] = [];
            for (let i = 0; i < 17; i++) {
                colors.push(0.0);
            }
            for (let m = 0; m < Donut_GetSdkMeshMaterialCount(mesh); m++) {
                Donut_CopySdkMeshMaterialColors(mesh, m, Ref(colors[0]));
                let allZero = true;
                for (let i = 0; i < 8; i++) {
                    if (colors[i] != 0.0) {
                        allZero = false;
                    }
                }
                if (allZero) {
                    this.materialColors.push(1.0);
                    this.materialColors.push(1.0);
                    this.materialColors.push(1.0);
                    this.materialColors.push(1.0);
                    this.materialSpecular.push(0.0);
                    this.materialSpecular.push(0.0);
                    this.materialSpecular.push(0.0);
                    this.materialSpecular.push(1.0);
                    for (let i = 0; i < 3; i++) {
                        this.materialEmissive.push(0.0);
                    }
                } else {
                    for (let i = 0; i < 3; i++) {
                        this.materialEmissive.push(colors[12 + i]);
                    }
                    this.materialColors.push(colors[0]);
                    this.materialColors.push(colors[1]);
                    this.materialColors.push(colors[2]);
                    this.materialColors.push(colors[3] != 1.0 && colors[3] != 0.0 ? colors[3] : 1.0);
                    // Donut_CopySdkMeshMaterialColors: diffuse, ambient, specular, emissive, power.
                    const power = colors[16];
                    if (power > 0.0 && (colors[8] != 0.0 || colors[9] != 0.0 || colors[10] != 0.0)) {
                        this.materialSpecular.push(colors[8]);
                        this.materialSpecular.push(colors[9]);
                        this.materialSpecular.push(colors[10]);
                        this.materialSpecular.push(power);
                    } else {
                        // DisableSpecular: black, power 1.
                        this.materialSpecular.push(0.0);
                        this.materialSpecular.push(0.0);
                        this.materialSpecular.push(0.0);
                        this.materialSpecular.push(1.0);
                    }
                }
                const textureName = Donut_GetSdkMeshMaterialTexture(mesh, m, 0);
                const texture = textureName == "" ? null : app.loadTexture(commandList, MEDIA_DIR + textureName, 0);
                if (!texture) {
                    console.log(`${file}: cannot load the material's texture ${textureName}`);
                    ok = false;
                } else {
                    this.materialTextures.push(texture as TextureHandle);
                }
                if (dualTexture) {
                    // The SDKMESH material's specular texture (Donut_GetSdkMeshMaterialTexture's 2).
                    const texture2Name = Donut_GetSdkMeshMaterialTexture(mesh, m, 2);
                    const texture2 = texture2Name == "" ? null : app.loadTexture(commandList, MEDIA_DIR + texture2Name, 0);
                    if (!texture2) {
                        console.log(`${file}: cannot load the material's second texture ${texture2Name}`);
                        ok = false;
                    } else {
                        this.materialTextures2.push(texture2 as TextureHandle);
                    }
                }
            }

            for (let m = 0; m < Donut_GetSdkMeshMeshCount(mesh); m++) {
                for (let j = 0; j < Donut_GetSdkMeshMeshSubsetCount(mesh, m); j++) {
                    const subset = Donut_GetSdkMeshMeshSubset(mesh, m, j);
                    if (Donut_GetSdkMeshSubsetPrimitiveType(mesh, subset) != 0) {
                        console.log(`${file}: only triangle lists are supported`);
                        ok = false;
                    }
                    this.partVertexBuffers.push(Donut_GetSdkMeshMeshVertexBuffer(mesh, m));
                    this.partIndexBuffers.push(Donut_GetSdkMeshMeshIndexBuffer(mesh, m));
                    this.partMaterials.push(Donut_GetSdkMeshSubsetMaterial(mesh, subset));
                    this.partIndexCounts.push(Donut_GetSdkMeshSubsetIndexCount(mesh, subset));
                    this.partStartIndices.push(Donut_GetSdkMeshSubsetIndexStart(mesh, subset));
                    this.partVertexOffsets.push(Donut_GetSdkMeshSubsetVertexStart(mesh, subset));
                }
            }

            Donut_DestroySdkMesh(mesh);
            app.releaseObject(binaryFile.handle);
            return ok;
        }
    }

    // --- The sample ---------------------------------------------------------------------------

    // Port of the Xbox ATG MouseCursor UWP sample (UWPSamples/System/MouseCursor): a menu of two
    // game modes, picked with the (absolute) mouse cursor. The first-person shooter mode captures
    // the mouse and turns the camera by its relative motion (move-look) in a room; the real-time
    // strategy mode captures it too and moves a cursor of its own (the sample's clip cursor mode),
    // scrolling the map when it nears the window's edges. Escape, or the window losing the focus,
    // returns to the menu (Escape there closes the window).
    //
    // The sample's Main.cpp handles the UWP window's pointer events; that's onMousePos,
    // onMouseButton and onKey here, with GLFW's disabled cursor mode for the captured mouse (raw
    // mouse motion as UWP's MouseMoved). Its Sample class is the rest.
    class MouseCursorPass {
        private app: App;

        // Main.cpp's state: the mode, the virtual cursor's on-screen position.
        private absolute: boolean;
        private relative: boolean;
        private clipCursor: boolean;
        private virtualX: number;
        private virtualY: number;
        // The mouse's last position (in the captured modes, GLFW's virtual position), and whether
        // the next one only resynchronizes it (after the cursor mode changed).
        private mouseX: number;
        private mouseY: number;
        private resyncMouse: boolean;

        // Sample's state.
        isAbsolute: boolean;
        isRelative: boolean;
        isClipCursor: boolean;
        highlightFPS: boolean;
        highlightRTS: boolean;
        private eyeFPS: number[];
        private targetFPS: number[];
        private eyeRTS: number[];
        private targetRTS: number[];
        private eye: number[];
        private target: number[];
        private pitch: number;
        private yaw: number;
        private world: number[];
        private view: number[];
        private proj: number[];
        screenX: number;
        screenY: number;
        // Left, top, right, bottom.
        fpsTile: int[];
        rtsTile: int[];
        fontPosTitle: number[];
        fontPosSubtitle: number[];
        fontPosFPS: number[];
        fontPosRTS: number[];
        frameWidth: int;
        frameHeight: int;

        private modelFPS: Model;
        private modelRTS: Model;
        private backgroundTexture: TextureHandle;
        private tileTexture: TextureHandle;
        private tileBorderTexture: TextureHandle;

        private spriteVS: Opaque;
        private spritePS: Opaque;
        private spriteLayout: Opaque;
        private spriteSampler: SamplerHandle;
        private backgroundBindingSet: BindingSet;
        private tileBindingSet: BindingSet;
        private tileBorderBindingSet: BindingSet;
        private dualVS: Opaque;
        private dualPS: Opaque;
        private basicVS: Opaque;
        private basicPS: Opaque;
        private dualInputLayout: Opaque;
        private basicInputLayout: Opaque;
        private modelLayout: Opaque;
        private parametersBuffer: BufferHandle;
        private spriteConstants: f32[];
        private parameters: f32[];

        // The depth buffer (D24S8, as the sample's) and a framebuffer per back buffer, for the back
        // buffers' size, and the pipelines made for them.
        private depth: TextureHandle;
        private framebuffers: Opaque[];
        private pipelinesCreated: boolean;
        private spritePipeline: Opaque;
        private dualPipeline: Opaque;
        private basicPipeline: Opaque;

        constructor(app: App) {
            this.app = app;
            this.absolute = true;
            this.relative = false;
            this.clipCursor = false;
            this.virtualX = 0.0;
            this.virtualY = 0.0;
            this.mouseX = 0.0;
            this.mouseY = 0.0;
            this.resyncMouse = true;

            this.isAbsolute = true;
            this.isRelative = false;
            this.isClipCursor = false;
            this.highlightFPS = false;
            this.highlightRTS = false;
            this.eyeFPS = [0.0, 20.0, -20.0];
            this.targetFPS = [0.0, 20.0, 0.0];
            this.eyeRTS = [0.0, 300.0, 0.0];
            this.targetRTS = [0.01, 300.1, 0.01];
            this.eye = [0.0, 20.0, 0.0];
            this.target = [0.01, 20.1, 0.01];
            this.pitch = 0.0;
            this.yaw = 0.0;
            this.world = identity();
            this.view = identity();
            this.proj = identity();
            this.screenX = 0.0;
            this.screenY = 0.0;
            this.fpsTile = [0, 0, 0, 0];
            this.rtsTile = [0, 0, 0, 0];
            this.fontPosTitle = [0.0, 0.0];
            this.fontPosSubtitle = [0.0, 0.0];
            this.fontPosFPS = [0.0, 0.0];
            this.fontPosRTS = [0.0, 0.0];
            this.frameWidth = 0;
            this.frameHeight = 0;

            this.modelFPS = new Model();
            this.modelRTS = new Model();
            this.framebuffers = [];
            this.pipelinesCreated = false;
            this.spriteConstants = [];
            for (let i = 0; i < SPRITE_FLOATS; i++) {
                this.spriteConstants.push(0.0);
            }
            this.parameters = [];
            for (let i = 0; i < PARAMETERS_FLOATS; i++) {
                this.parameters.push(0.0);
            }
        }

        // --- Sample: mouse cursor camera and target updates -------------------------------------

        // Update the pointer location in clip cursor mode
        updatePointer(x: number, y: number): void {
            this.screenX = x;
            this.screenY = y;
        }

        // Change the target value based on the mouse movement for move-look/relative mouse mode
        updateCamera(dx: number, dy: number): void {
            // Adjust pitch and yaw based on the mouse movement
            this.pitch = f(this.pitch + f(dy * ROTATION_GAIN));
            this.yaw = f(this.yaw + f(dx * ROTATION_GAIN));

            // Limit to avoid looking directly up or down
            const limit = f(PI / 2.0 - 0.01);
            this.pitch = maxf(-limit, minf(limit, this.pitch));

            if (this.yaw > PI) {
                this.yaw = f(this.yaw - PI * 2.0);
            } else if (this.yaw < -PI) {
                this.yaw = f(this.yaw + PI * 2.0);
            }

            const y = f(Math.sin(this.pitch));
            const r = f(Math.cos(this.pitch));
            const z = f(r * f(Math.cos(this.yaw)));
            const x = f(r * f(Math.sin(this.yaw)));

            this.target = [f(this.eye[0] + x), f(this.eye[1] + y), f(this.eye[2] + z)];

            this.setView();
        }

        // Move the camera forward or backward
        moveForward(amount: number): void {
            const movement = [f(this.target[0] - this.eye[0]), 0.0, f(this.target[2] - this.eye[2])];
            const eyeTemp = [f(this.eye[0] - f(amount * movement[0])), this.eye[1], f(this.eye[2] - f(amount * movement[2]))];
            if (inBounds(eyeTemp)) {
                this.eye = eyeTemp;
                this.target = [f(this.target[0] - f(amount * movement[0])), this.target[1], f(this.target[2] - f(amount * movement[2]))];
                this.setView();
            }
        }

        // Move the camera to the right or left
        moveRight(amount: number): void {
            const movement = [-f(this.target[2] - this.eye[2]), 0.0, f(this.target[0] - this.eye[0])];
            const eyeTemp = [f(this.eye[0] + f(amount * movement[0])), this.eye[1], f(this.eye[2] + f(amount * movement[2]))];
            if (inBounds(eyeTemp)) {
                this.eye = eyeTemp;
                this.target = [f(this.target[0] + f(amount * movement[0])), this.target[1], f(this.target[2] + f(amount * movement[2]))];
                this.setView();
            }
        }

        // Update the viewport based on the updated eye and target values
        setView(): void {
            this.view = lookAtRH(this.eye, this.target, [0.0, 1.0, 0.0]);
            this.proj = perspectiveFovLH(f(PI / 4.0), f(f(this.frameWidth) / f(this.frameHeight)), 0.1, 10000.0);
        }

        // Set mode to relative ( 1 ), absolute ( 0 ), or clip cursor ( 2 )
        setMode(x: number, y: number): int {
            // If entering FPS or relative mode
            if (inTile(this.fpsTile, x, y)) {
                this.screenX = this.frameWidth / 2.0;
                this.screenY = this.frameHeight / 2.0;

                this.isRelative = true;
                this.isAbsolute = false;
                this.isClipCursor = false;
                this.highlightFPS = false;
                this.highlightRTS = false;
                this.world = multiply(rotationX(f(PI / 2.0)), rotationY(PI));
                this.eye = [this.eyeFPS[0], this.eyeFPS[1], this.eyeFPS[2]];
                this.target = [this.targetFPS[0], this.targetFPS[1], this.targetFPS[2]];
                this.updateCamera(0.0, 0.0);
                this.setView();
                return RELATIVE_MOUSE;
            }
            // If entering RTS or clipCursor mode
            if (inTile(this.rtsTile, x, y)) {
                this.isRelative = false;
                this.isAbsolute = false;
                this.isClipCursor = true;
                this.highlightFPS = false;
                this.highlightRTS = false;
                this.world = multiply(rotationX(f(PI / 2.0)), rotationY(f(5.0 * PI / 4.0)));
                this.eye = [this.eyeRTS[0], this.eyeRTS[1], this.eyeRTS[2]];
                this.target = [this.targetRTS[0], this.targetRTS[1], this.targetRTS[2]];
                this.setView();
                return CLIPCURSOR_MOUSE;
            }
            // Entering absolute mode
            if (this.isClipCursor) {
                this.eyeRTS = [this.eye[0], this.eye[1], this.eye[2]];
                this.targetRTS = [this.target[0], this.target[1], this.target[2]];
            }
            this.isRelative = false;
            this.isAbsolute = true;
            this.isClipCursor = false;
            return ABSOLUTE_MOUSE;
        }

        // When the mouse moves, check to see if it is on top of the FPS or RTS selection tiles
        checkLocation(x: number, y: number): void {
            if (this.isAbsolute) {
                // If hovering over FPS or relative selection
                if (inTile(this.fpsTile, x, y)) {
                    this.highlightFPS = true;
                    this.highlightRTS = false;
                } else if (inTile(this.rtsTile, x, y)) {
                    // If hovering over RTS or clipCursor selection
                    this.highlightRTS = true;
                    this.highlightFPS = false;
                } else {
                    this.highlightFPS = false;
                    this.highlightRTS = false;
                }
            }
        }

        // Sample::CreateWindowSizeDependentResources: the menu's layout.
        layout(width: int, height: int): void {
            // Update pointer location
            if (this.isRelative) {
                this.screenX = width / 2.0;
                this.screenY = height / 2.0;
            }

            // Initialize UI tiles and font locations (LONG casts truncate)
            const fps = this.fpsTile;
            fps[0] = Math.trunc(f(0.325 * width));
            fps[1] = Math.trunc(f(0.44 * height));
            fps[2] = Math.trunc(f(0.495 * width));
            fps[3] = Math.trunc(f(0.66 * height));
            fps[3] = Math.max(fps[3], fps[1] + 150);
            fps[0] = Math.min(fps[0], Math.trunc(fps[2] - (fps[3] - fps[1]) * 4 / 3.0));

            const rts = this.rtsTile;
            rts[0] = Math.trunc(f(0.505 * width));
            rts[1] = fps[1];
            rts[2] = Math.trunc(f(0.675 * width));
            rts[3] = fps[3];
            rts[2] = Math.max(rts[2], Math.trunc(rts[0] + (rts[3] - rts[1]) * 4 / 3.0));

            this.fontPosTitle = [width / 2.0, f(height * 0.27)];
            this.fontPosSubtitle = [width / 2.0, f(height * 0.36)];
            this.fontPosFPS = [fps[0] + (fps[2] - fps[0]) / 2.0, fps[1] + (fps[3] - fps[1]) / 2.0];
            this.fontPosRTS = [rts[0] + (rts[2] - rts[0]) / 2.0, this.fontPosFPS[1]];
        }

        // --- Main.cpp: the window's pointer and keyboard events --------------------------------

        // The mouse is captured and hidden: the sample draws its own cursor.
        capture(x: number, y: number): void {
            this.app.setCursorMode(CursorMode.Disabled);
            this.resyncMouse = true;
            // Save the pointers position
            this.virtualX = maxf(0.0, minf(x, this.frameWidth));
            this.virtualY = maxf(0.0, minf(y, this.frameHeight));
        }

        // Back to the menu: the system cursor returns where the sample's was.
        release(): void {
            this.app.setCursorMode(CursorMode.Normal);
            this.resyncMouse = true;
            this.app.setCursorPosition(Math.trunc(this.virtualX), Math.trunc(this.virtualY));
            this.clipCursor = false;
            this.relative = false;
            this.absolute = true;
            this.setMode(0.0, 0.0);
        }

        // OnPointerMoved in absolute mode (hover), OnMouseMoved in the captured ones.
        onMousePos(x: number, y: number): int {
            const dx = x - this.mouseX;
            const dy = y - this.mouseY;
            const resync = this.resyncMouse;
            this.mouseX = x;
            this.mouseY = y;
            this.resyncMouse = false;
            if (this.absolute) {
                this.checkLocation(x, y);
            } else if (resync) {
                return 1;
            } else if (this.clipCursor) {
                this.virtualX = maxf(0.0, minf(this.virtualX + dx, this.frameWidth));
                this.virtualY = maxf(0.0, minf(this.virtualY + dy, this.frameHeight));
                this.updatePointer(this.virtualX, this.virtualY);
            } else if (this.relative) {
                this.updateCamera(dx, dy);
            }
            return 1;
        }

        // OnPointerPressed: in absolute mode, a tile clicked enters its mode.
        onMouseButton(button: int, action: int, mods: int): int {
            if (action == ACTION_PRESS && this.absolute) {
                const mode = this.setMode(this.mouseX, this.mouseY);
                if (mode == RELATIVE_MOUSE) {
                    this.absolute = false;
                    this.relative = true;
                    this.capture(this.mouseX, this.mouseY);
                } else if (mode == CLIPCURSOR_MOUSE) {
                    this.absolute = false;
                    this.clipCursor = true;
                    this.capture(this.mouseX, this.mouseY);
                }
            }
            return 1;
        }

        // OnKeyDown: Escape leaves the captured modes (and goes on to InputPass, closing the
        // window, from the menu).
        onKey(key: int, scancode: int, action: int, mods: int): int {
            if (key == KEY_ESCAPE && action == ACTION_PRESS && !this.absolute) {
                this.release();
                return 1;
            }
            return 0;
        }

        // Sample::Update: in clip cursor mode, scrolling when the cursor nears the window's edges
        // (each frame, as the sample). OnPointerCaptureLost: the captured modes end when the
        // window loses the focus.
        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
            if (!this.absolute && this.app.isWindowFocused() == 0) {
                this.release();
            }

            // In clip cursor mode implement screen scrolling when the mouse is near the edge of the screen
            if (this.isClipCursor) {
                if (this.screenX < 20.0) {
                    this.moveRight(-25.0);
                } else if (this.screenX > this.frameWidth - 20.0) {
                    this.moveRight(25.0);
                }
                if (this.screenY < 20.0) {
                    this.moveForward(25.0);
                } else if (this.screenY > this.frameHeight - 20.0) {
                    this.moveForward(-25.0);
                }
            }
        }

        // --- Rendering ----------------------------------------------------------------------------

        // The framebuffers of the back buffers go before the back buffers do.
        onBackBufferResizing(): void {
            this.releaseTargets();
        }

        releaseTargets(): void {
            for (let i = 0; i < this.framebuffers.length; i++) {
                this.app.releaseResource(this.framebuffers[i]);
            }
            if (this.framebuffers.length > 0) {
                this.app.releaseResource(this.depth);
            }
            this.framebuffers = [];
        }

        createPipelines(): void {
            const framebuffer = this.framebuffers[0];

            // SpriteBatch: premultiplied alpha blending (CommonStates::AlphaBlend), no depth, no culling.
            const spriteDesc = GraphicsPipelineDesc.create(this.spriteVS, this.spritePS);
            spriteDesc.addBindingLayout(this.spriteLayout);
            spriteDesc.setDepthState(0, 0, ComparisonFunc.Always);
            spriteDesc.setRasterState(CullMode.None, FillMode.Solid, 0);
            spriteDesc.setBlendState(1, BlendFactor.One, BlendFactor.InvSrcAlpha, BlendOp.Add,
                BlendFactor.One, BlendFactor.InvSrcAlpha, BlendOp.Add);
            this.spritePipeline = this.app.createGraphicsPipelineFromDesc(spriteDesc, framebuffer);

            // Model::Draw's opaque parts: no blending, DepthDefault (less or equal), clockwise
            // front faces with the back ones culled (ModelLoader_CounterClockwise ->
            // CullCounterClockwise), depth clip on.
            const dualDesc = GraphicsPipelineDesc.create(this.dualVS, this.dualPS);
            dualDesc.setInputLayout(this.dualInputLayout);
            dualDesc.addBindingLayout(this.modelLayout);
            dualDesc.setDepthState(1, 1, ComparisonFunc.LessOrEqual);
            dualDesc.setRasterState(CullMode.Back, FillMode.Solid, 0);
            dualDesc.setDepthClip(1);
            this.dualPipeline = this.app.createGraphicsPipelineFromDesc(dualDesc, framebuffer);

            const basicDesc = GraphicsPipelineDesc.create(this.basicVS, this.basicPS);
            basicDesc.setInputLayout(this.basicInputLayout);
            basicDesc.addBindingLayout(this.modelLayout);
            basicDesc.setDepthState(1, 1, ComparisonFunc.LessOrEqual);
            basicDesc.setRasterState(CullMode.Back, FillMode.Solid, 0);
            basicDesc.setDepthClip(1);
            this.basicPipeline = this.app.createGraphicsPipelineFromDesc(basicDesc, framebuffer);
            this.pipelinesCreated = true;
        }

        // Main.cpp's OnWindowSizeChanged (the virtual cursor follows) and the sample's
        // CreateWindowSizeDependentResources; the depth buffer and framebuffers.
        resize(width: int, height: int): void {
            const previousWidth = this.frameWidth;
            const previousHeight = this.frameHeight;
            this.releaseTargets();
            this.depth = this.app.createDepthTexture(width, height, Format.D24S8, 1.0, "Depth");
            const count = this.app.getBackBufferCount();
            for (let i = 0; i < count; i++) {
                this.framebuffers.push(this.app.createFramebuffer(this.app.getBackBuffer(i), this.depth));
            }
            if (!this.pipelinesCreated) {
                this.createPipelines();
            }
            this.frameWidth = width;
            this.frameHeight = height;

            if (this.relative) {
                this.virtualX = width / 2.0;
                this.virtualY = height / 2.0;
            } else if (this.clipCursor && previousWidth > 0) {
                this.virtualX = this.virtualX * (width / previousWidth);
                this.virtualY = this.virtualY * (height / previousHeight);
                this.updatePointer(this.virtualX, this.virtualY);
            }
            this.layout(width, height);
        }

        // SpriteBatch::Draw(texture, destinationRectangle), white.
        drawSprite(frame: Frame, framebuffer: Opaque, bindingSet: BindingSet, left: number, top: number, right: number, bottom: number): void {
            const c = this.spriteConstants;
            c[0] = left;
            c[1] = top;
            c[2] = right;
            c[3] = bottom;
            c[4] = this.frameWidth;
            c[5] = this.frameHeight;
            c[8] = 1.0;
            c[9] = 1.0;
            c[10] = 1.0;
            c[11] = 1.0;
            frame.beginDrawToFramebuffer(this.spritePipeline, framebuffer);
            frame.drawAddBindingSet(bindingSet);
            frame.drawVerticesWithPushConstants(6, Ref(c[0]), SPRITE_FLOATS * 4);
        }

        // Model::Draw(context, states, world, view, proj): each part with its material's effect
        // (Model::UpdateEffectMatrices, EffectLights::SetConstants: ambient folded into emissive,
        // diffuse premultiplied by alpha).
        drawModel(frame: Frame, framebuffer: Opaque, model: Model, pipeline: Opaque): void {
            const commandList = frame.getCommandList();
            const p = this.parameters;
            const viewInverse = inverse(this.view);
            const worldInverseTranspose = transpose(inverse(this.world));
            const worldViewProj = multiply(multiply(this.world, this.view), this.proj);
            for (let i = 0; i < 16; i++) {
                p[PARAMETERS_WORLD + i] = this.world[i];
                p[PARAMETERS_WORLD_INVERSE_TRANSPOSE + i] = worldInverseTranspose[i];
                p[PARAMETERS_WORLD_VIEW_PROJ + i] = worldViewProj[i];
            }
            for (let i = 0; i < 3; i++) {
                p[PARAMETERS_EYE + i] = viewInverse[12 + i];
            }
            for (let light = 0; light < 3; light++) {
                for (let i = 0; i < 3; i++) {
                    p[PARAMETERS_LIGHTS + light * 4 + i] = DEFAULT_DIRECTIONS[light * 3 + i];
                    p[PARAMETERS_LIGHTS + 12 + light * 4 + i] = DEFAULT_DIFFUSE[light * 3 + i];
                    p[PARAMETERS_LIGHTS + 24 + light * 4 + i] = DEFAULT_SPECULAR[light * 3 + i];
                }
            }

            for (let part = 0; part < model.partMaterials.length; part++) {
                const material = model.partMaterials[part];
                const alpha = model.materialColors[material * 4 + 3];
                for (let i = 0; i < 3; i++) {
                    const diffuse = model.materialColors[material * 4 + i];
                    p[i] = f(diffuse * alpha);
                    p[PARAMETERS_EMISSIVE + i] = f((model.materialEmissive[material * 3 + i] + DEFAULT_AMBIENT[i] * diffuse) * alpha);
                    p[PARAMETERS_SPECULAR + i] = model.materialSpecular[material * 4 + i];
                }
                p[3] = alpha;
                p[PARAMETERS_SPECULAR + 3] = model.materialSpecular[material * 4 + 3];
                commandList.writeBuffer(this.parametersBuffer, Ref(p[0]), PARAMETERS_FLOATS * 4);

                frame.beginDrawToFramebuffer(pipeline, framebuffer);
                frame.drawAddBindingSet(model.materialBindingSets[material]);
                const ib = model.partIndexBuffers[part];
                if (model.index32[ib]) {
                    frame.drawSetIndexBuffer(model.indexBuffers[ib]);
                } else {
                    frame.drawSetIndexBuffer16(model.indexBuffers[ib]);
                }
                frame.drawAddVertexBuffer(model.vertexBuffers[model.partVertexBuffers[part]], 0, 0);
                frame.drawIndexedRange(model.partIndexCounts[part], model.partStartIndices[part], model.partVertexOffsets[part]);
            }
        }

        // Sample::Render: the menu's sprites (its text and the cursor are UserInterface's), or the
        // mode's model.
        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            if (this.framebuffers.length == 0 || this.frameWidth != width || this.frameHeight != height) {
                this.resize(width, height);
            }

            // Sample::Clear.
            const commandList = frame.getCommandList();
            const index = this.app.getCurrentBackBufferIndex();
            commandList.clearTextureFloat(this.app.getBackBuffer(index), CORNFLOWER_BLUE[0], CORNFLOWER_BLUE[1], CORNFLOWER_BLUE[2], 1.0);
            commandList.clearDepth(this.depth, 1.0);
            const framebuffer = this.framebuffers[index];

            if (this.isAbsolute) {
                this.drawSprite(frame, framebuffer, this.backgroundBindingSet, 0.0, 0.0, width, height);
                const fps = this.fpsTile;
                const rts = this.rtsTile;
                this.drawSprite(frame, framebuffer, this.tileBindingSet, fps[0], fps[1], fps[2], fps[3]);
                this.drawSprite(frame, framebuffer, this.tileBindingSet, rts[0], rts[1], rts[2], rts[3]);
                if (this.highlightFPS) {
                    this.drawSprite(frame, framebuffer, this.tileBorderBindingSet, fps[0], fps[1], fps[2], fps[3]);
                } else if (this.highlightRTS) {
                    this.drawSprite(frame, framebuffer, this.tileBorderBindingSet, rts[0], rts[1], rts[2], rts[3]);
                }
            } else if (this.isRelative) {
                this.drawModel(frame, framebuffer, this.modelFPS, this.dualPipeline);
            } else if (this.isClipCursor) {
                this.drawModel(frame, framebuffer, this.modelRTS, this.basicPipeline);
            }
        }

        // A sprite texture (CreateWICTextureFromFile: as stored, UNORM) and its binding set.
        loadSprite(commandList: CommandList, file: string): TextureHandle | null {
            const texture = this.app.loadTexture(commandList, MEDIA_DIR + file, 0);
            if (!texture) {
                console.log(`Cannot load ${file}: set XBOX_ATG_SAMPLES_DIR when configuring`);
            }
            return texture;
        }

        spriteBindingSet(texture: TextureHandle): BindingSet {
            const desc = BindingSetDesc.create();
            desc.bindPushConstants(0, SPRITE_FLOATS * 4);
            desc.bindTextureSRV(0, texture);
            desc.bindSampler(0, this.spriteSampler);
            return this.app.createBindingSetForLayout(desc, this.spriteLayout);
        }

        // Each material's binding set: the parameters, its texture(s) (the first again where
        // there's no second), Model::Draw's LinearWrap sampler.
        createMaterialBindingSets(model: Model, sampler: SamplerHandle, dualTexture: boolean): void {
            for (let m = 0; m < model.materialTextures.length; m++) {
                const desc = BindingSetDesc.create();
                desc.bindEntireConstantBuffer(0, this.parametersBuffer);
                desc.bindTextureSRV(0, model.materialTextures[m]);
                desc.bindTextureSRV(1, dualTexture ? model.materialTextures2[m] : model.materialTextures[m]);
                desc.bindSampler(0, sampler);
                model.materialBindingSets.push(this.app.createBindingSetForLayout(desc, this.modelLayout));
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const shader = "mouse_cursor.hlsl";
            this.spriteVS = this.app.createShader(shader, "sprite_vs", ShaderType.Vertex);
            this.spritePS = this.app.createShader(shader, "sprite_ps", ShaderType.Pixel);
            this.dualVS = this.app.createShader(shader, "dual_texture_vs", ShaderType.Vertex);
            this.dualPS = this.app.createShader(shader, "dual_texture_ps", ShaderType.Pixel);
            this.basicVS = this.app.createShader(shader, "basic_vs", ShaderType.Vertex);
            this.basicPS = this.app.createShader(shader, "basic_ps", ShaderType.Pixel);
            if (!this.spriteVS || !this.spritePS || !this.dualVS || !this.dualPS || !this.basicVS || !this.basicPS) {
                return false;
            }

            // The models' vertices: the FPS room's position, normal, two texture coordinates,
            // tangent, binormal (64 bytes); the RTS map's position, normal, texture coordinates,
            // tangent, binormal (56 bytes).
            const dualLayoutDesc = InputLayoutDesc.create();
            dualLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, 64);
            dualLayoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 24, 0, 64);
            dualLayoutDesc.addVertexAttribute("LIGHTMAPCOORD", Format.RG32_FLOAT, 32, 0, 64);
            this.dualInputLayout = this.app.createInputLayout(dualLayoutDesc, this.dualVS);
            const basicLayoutDesc = InputLayoutDesc.create();
            basicLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, 56);
            basicLayoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, 12, 0, 56);
            basicLayoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 24, 0, 56);
            this.basicInputLayout = this.app.createInputLayout(basicLayoutDesc, this.basicVS);

            // Before any command list is open (it creates Donut's CommonRenderPasses).
            const linearWrap = this.app.getCommonSampler(CommonSampler.LinearWrap);
            // SpriteBatch's LinearClamp; WIC-loaded textures have one level (Donut makes PNGs a
            // chain), so only the first is sampled.
            this.spriteSampler = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Clamp, 0.0, 0.0, 0.0, 1.0);

            const commandList = this.app.createCommandList();
            commandList.open();
            let ok = this.modelFPS.load(this.app, commandList, "FPSRoom.sdkmesh", 64, true);
            // Note that this model uses 32-bit index buffers so it can't be used w/ Feature Level 9.1
            ok = this.modelRTS.load(this.app, commandList, "3DRTSMap.sdkmesh", 56, false) && ok;
            const background = this.loadSprite(commandList, "background_flat.png");
            const tile = this.loadSprite(commandList, "green_tile.png");
            const tileBorder = this.loadSprite(commandList, "green_tile_border.png");
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!ok || !background || !tile || !tileBorder) {
                return false;
            }
            this.backgroundTexture = background as TextureHandle;
            this.tileTexture = tile as TextureHandle;
            this.tileBorderTexture = tileBorder as TextureHandle;

            const spriteLayoutDesc = BindingLayoutDesc.create();
            spriteLayoutDesc.layoutPushConstants(0, SPRITE_FLOATS * 4);
            spriteLayoutDesc.layoutTextureSRV(0);
            spriteLayoutDesc.layoutSampler(0);
            this.spriteLayout = this.app.createBindingLayout(spriteLayoutDesc, ShaderType.All);
            this.backgroundBindingSet = this.spriteBindingSet(this.backgroundTexture);
            this.tileBindingSet = this.spriteBindingSet(this.tileTexture);
            this.tileBorderBindingSet = this.spriteBindingSet(this.tileBorderTexture);

            this.parametersBuffer = this.app.createVolatileConstantBuffer(PARAMETERS_FLOATS * 4, "Parameters");
            const modelLayoutDesc = BindingLayoutDesc.create();
            modelLayoutDesc.layoutVolatileConstantBuffer(0);
            modelLayoutDesc.layoutTextureSRV(0);
            modelLayoutDesc.layoutTextureSRV(1);
            modelLayoutDesc.layoutSampler(0);
            this.modelLayout = this.app.createBindingLayout(modelLayoutDesc, ShaderType.All);
            this.createMaterialBindingSets(this.modelFPS, linearWrap, true);
            this.createMaterialBindingSets(this.modelRTS, linearWrap, false);

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            // Animate runs unfocused too, to see the focus go (the sample's capture lost).
            pass.setRunWhenUnfocused(1);
            return true;
        }
    }

    // The sample's SpriteFont text (centered on its positions, white): the menu's title, subtitle
    // and tile labels; the cursor ("+" in Courier_36) in the captured modes, drawn here as the
    // glyph's two antialiased strokes (a 1 pixel line with third-covered sides, offset from the
    // position as the glyph is).
    class UserInterface {
        private sample: MouseCursorPass;
        private app: App;

        titleFont: ImGuiFont;
        subtitleFont: ImGuiFont;
        tileFont: ImGuiFont;

        constructor(sample: MouseCursorPass, app: App) {
            this.sample = sample;
            this.app = app;
        }

        // SpriteFont::DrawString with its origin at MeasureString / 2: the lines' block centered
        // on (x, y), each line placed in its sprite font line.
        centered(x: number, y: number, lines: string[], fontSize: number, lineSpacing: number): void {
            let width = 0.0;
            for (let i = 0; i < lines.length; i++) {
                width = Math.max(width, Donut_ImGuiCalcTextWidth(lines[i]));
            }
            const left = x - width / 2.0;
            const top = y - lines.length * lineSpacing / 2.0 + (lineSpacing - fontSize) / 2.0;
            for (let i = 0; i < lines.length; i++) {
                Donut_ImGuiDrawText(left, top + i * lineSpacing, lines[i], 1.0, 1.0, 1.0, 1.0, 0);
            }
        }

        cursor(x: number, y: number): void {
            const cx = Math.floor(x) + 4.0;
            const cy = Math.floor(y) - 1.0;
            const side = 0.333;
            Donut_ImGuiDrawRect(cx, cy - 11.0, cx + 1.0, cy + 12.0, 1.0, 1.0, 1.0, 1.0);
            Donut_ImGuiDrawRect(cx - 1.0, cy - 11.0, cx, cy + 12.0, 1.0, 1.0, 1.0, side);
            Donut_ImGuiDrawRect(cx + 1.0, cy - 11.0, cx + 2.0, cy + 12.0, 1.0, 1.0, 1.0, side);
            Donut_ImGuiDrawRect(cx - 10.0, cy, cx, cy + 1.0, 1.0, 1.0, 1.0, 1.0);
            Donut_ImGuiDrawRect(cx + 1.0, cy, cx + 11.0, cy + 1.0, 1.0, 1.0, 1.0, 1.0);
            Donut_ImGuiDrawRect(cx - 10.0, cy - 1.0, cx - 1.0, cy, 1.0, 1.0, 1.0, side);
            Donut_ImGuiDrawRect(cx + 2.0, cy - 1.0, cx + 11.0, cy, 1.0, 1.0, 1.0, side);
            Donut_ImGuiDrawRect(cx - 10.0, cy + 1.0, cx - 1.0, cy + 2.0, 1.0, 1.0, 1.0, side);
            Donut_ImGuiDrawRect(cx + 2.0, cy + 1.0, cx + 11.0, cy + 2.0, 1.0, 1.0, 1.0, side);
        }

        buildUI(): void {
            const sample = this.sample;
            if (sample.isAbsolute) {
                this.titleFont.push();
                this.centered(sample.fontPosTitle[0], sample.fontPosTitle[1], ["Mouse Cursor Sample: 0"], TITLE_FONT_SIZE, TITLE_LINE_SPACING);
                Donut_ImGuiPopFont();
                this.subtitleFont.push();
                this.centered(sample.fontPosSubtitle[0], sample.fontPosSubtitle[1], ["Choose a game mode"], SUBTITLE_FONT_SIZE, SUBTITLE_LINE_SPACING);
                Donut_ImGuiPopFont();
                this.tileFont.push();
                this.centered(sample.fontPosFPS[0], sample.fontPosFPS[1], ["First-person ", "   Shooter"], TILE_FONT_SIZE, TILE_LINE_SPACING);
                this.centered(sample.fontPosRTS[0], sample.fontPosRTS[1], ["Real-time ", " Strategy"], TILE_FONT_SIZE, TILE_LINE_SPACING);
                Donut_ImGuiPopFont();
            } else {
                this.cursor(sample.screenX, sample.screenY);
            }
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(): boolean {
            const imguiPass = this.app.addImGuiPass(this.buildUI);
            if (imguiPass.isNull()) {
                return false;
            }
            this.titleFont = imguiPass.createFont(FONT_PATH, TITLE_FONT_SIZE);
            this.subtitleFont = imguiPass.createFont(FONT_PATH, SUBTITLE_FONT_SIZE);
            this.tileFont = imguiPass.createFont(FONT_PATH, TILE_FONT_SIZE);
            if (this.titleFont.isNull() || this.subtitleFont.isNull() || this.tileFont.isNull()) {
                console.log("Cannot load the font: set DONUT_SAMPLES_MEDIA_DIR when configuring");
                return false;
            }
            return true;
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("mouse_cursor");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        let options = AppOptions.UnormBackBuffer;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = options | AppOptions.DebugRuntime;
            }
        }

        // The sample's B8G8R8A8_UNORM back buffers, in a 1280 x 720 window.
        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        // Before the sample's pass, which then sees the keys first (Escape leaves the captured modes).
        const input = new InputPass(app.handle);

        const sample = new MouseCursorPass(app);
        if (!sample.init()) {
            app.destroy();
            return 1;
        }

        const ui = new UserInterface(sample, app);
        if (!ui.init()) {
            app.destroy();
            return 1;
        }

        app.run();
        app.destroy();
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return MouseCursor.main(argc, argv);
}

// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace Bokeh {
    const WINDOW_TITLE = "Donut Example: Bokeh";
    const MEDIA_DIR = "media/bokeh/";
    const FONT_PATH = "media/fonts/OpenSans/OpenSans-Regular.ttf";
    // The sample's SegoeUI_18 sprite font (the one it takes up to 1080 lines),
    // its lines 32 pixels apart.
    // ImGui sizes a font by its ascent + descent (1.3618 OpenSans ems), so the 23 pixel em that gives
    // its strings' widths is 31.5.
    const FONT_SIZE = 31.5;
    const LINE_SPACING = 32.0;

    // ATG::Colors::Green (#107c10), stored as is in the UNORM back buffer as the sample's.
    const GREEN_R = 0.062745102;
    const GREEN_G = 0.486274511;
    const GREEN_B = 0.062745102;

    // shadersettings.h.
    const FIRST_DOWNSAMPLE = 2;
    const NUM_RADII_WEIGHTS = 64;

    const PRESET_SCENE_COUNT = 4;

    // Bokeh12.cpp: the models, and the scene's objects: six microscopes around the city's column.
    const MODEL_FILES = ["scanner.sdkmesh", "occcity.sdkmesh", "column.sdkmesh"];
    const OBJECT_COUNT = 8;
    const OBJECT_MODELS = [0, 0, 0, 0, 0, 0, 1, 2];
    const OBJECT_TURNS = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 0.0, 0.0];

    // BokehCB of BokehEffect12.h (bokeh.hlsl's cbuffer bokeh), in floats.
    const BOKEH_CB_FLOATS = 60;
    const BOKEH_CB_VIEWPORTS = 12;
    const BOKEH_CB_SWITCHOVER = 36;
    const BOKEH_CB_ENERGY_SCALE = 40;
    const BOKEH_CB_INV_PROJ = 44;

    // BasicEffect's constant buffer (bokeh_scene.hlsl): DiffuseColor, EmissiveColor, SpecularColor
    // and SpecularPower, the three lights' directions, diffuse and specular colors, EyePosition,
    // World, WorldInverseTranspose, WorldViewProj; one 512-byte slice per object.
    const PARAMETERS_FLOATS = 100;
    const PARAMETERS_EMISSIVE = 4;
    const PARAMETERS_SPECULAR = 8;
    const PARAMETERS_LIGHTS = 12;
    const PARAMETERS_EYE = 48;
    const PARAMETERS_WORLD = 52;
    const PARAMETERS_WORLD_INVERSE_TRANSPOSE = 68;
    const PARAMETERS_WORLD_VIEW_PROJ = 84;
    const PARAMETERS_SLICE_FLOATS = 128;

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

    // GPU timers (the sample's TimerIndex), read back TIMER_FRAMES frames later.
    const TI_FRAME = 0;
    const TI_SCENE = 1;
    const TI_BOKEH = 2;
    const TI_COPY = 3;
    const TIMER_COUNT = 4;
    const TIMER_FRAMES = 3;

    // GLFW keys.
    const KEY_1 = 49;
    const KEY_A = 65;
    const KEY_D = 68;
    const KEY_E = 69;
    const KEY_Q = 81;
    const KEY_S = 83;
    const KEY_W = 87;
    const KEY_RIGHT = 262;
    const KEY_LEFT = 263;
    const KEY_DOWN = 264;
    const KEY_UP = 265;
    const ACTION_RELEASE = 0;
    const ACTION_PRESS = 1;

    // The sample's Update runs once per frame on the console, at 60 Hz: its per-frame steps are
    // scaled to the frame's time here.
    const STEPS_PER_SECOND = 60.0;

    function formatFixed(value: number, digits: int): string {
        let scale = 1.0;
        for (let i = 0; i < digits; i++) {
            scale *= 10.0;
        }
        const scaled = Math.round(Math.abs(value) * scale);
        const whole: int = Math.floor(scaled / scale);
        const fraction: int = scaled - whole * scale;
        let fractionText = `${fraction}`;
        while (fractionText.length < digits) {
            fractionText = "0" + fractionText;
        }
        const sign = value < 0.0 && scaled > 0.0 ? "-" : "";
        return digits > 0 ? `${sign}${whole}.${fractionText}` : `${sign}${whole}`;
    }

    // --- DirectXMath, row-major for mul(vector, matrix) --------------------------------------

    function multiply(a: number[], b: number[]): number[] {
        let m: number[] = [];
        for (let row = 0; row < 4; row++) {
            for (let column = 0; column < 4; column++) {
                let sum = 0.0;
                for (let k = 0; k < 4; k++) {
                    sum += a[row * 4 + k] * b[k * 4 + column];
                }
                m.push(Math.fround(sum));
            }
        }
        return m;
    }

    function transpose(a: number[]): number[] {
        let m: number[] = [];
        for (let row = 0; row < 4; row++) {
            for (let column = 0; column < 4; column++) {
                m.push(a[column * 4 + row]);
            }
        }
        return m;
    }

    // XMMatrixInverse (by cofactors, in doubles).
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
            Math.fround((a11 * b11 - a12 * b10 + a13 * b09) * invDet),
            Math.fround((a02 * b10 - a01 * b11 - a03 * b09) * invDet),
            Math.fround((a31 * b05 - a32 * b04 + a33 * b03) * invDet),
            Math.fround((a22 * b04 - a21 * b05 - a23 * b03) * invDet),
            Math.fround((a12 * b08 - a10 * b11 - a13 * b07) * invDet),
            Math.fround((a00 * b11 - a02 * b08 + a03 * b07) * invDet),
            Math.fround((a32 * b02 - a30 * b05 - a33 * b01) * invDet),
            Math.fround((a20 * b05 - a22 * b02 + a23 * b01) * invDet),
            Math.fround((a10 * b10 - a11 * b08 + a13 * b06) * invDet),
            Math.fround((a01 * b08 - a00 * b10 - a03 * b06) * invDet),
            Math.fround((a30 * b04 - a31 * b02 + a33 * b00) * invDet),
            Math.fround((a21 * b02 - a20 * b04 - a23 * b00) * invDet),
            Math.fround((a11 * b07 - a10 * b09 - a12 * b06) * invDet),
            Math.fround((a00 * b09 - a01 * b07 + a02 * b06) * invDet),
            Math.fround((a31 * b01 - a30 * b03 - a32 * b00) * invDet),
            Math.fround((a20 * b03 - a21 * b01 + a22 * b00) * invDet),
        ];
    }

    // XMMatrixRotationY.
    function rotationY(angle: number): number[] {
        const s = Math.fround(Math.sin(angle));
        const c = Math.fround(Math.cos(angle));
        return [c, 0.0, -s, 0.0, 0.0, 1.0, 0.0, 0.0, s, 0.0, c, 0.0, 0.0, 0.0, 0.0, 1.0];
    }

    function normalize3(v: number[]): number[] {
        const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        return [v[0] / length, v[1] / length, v[2] / length];
    }

    function cross3(a: number[], b: number[]): number[] {
        return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    }

    function dot3(a: number[], b: number[]): number {
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    }

    // XMMatrixLookAtLH: XMMatrixLookToLH towards the focus.
    function lookAtLH(eye: number[], focus: number[], up: number[]): number[] {
        const r2 = normalize3([focus[0] - eye[0], focus[1] - eye[1], focus[2] - eye[2]]);
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

    // XMMatrixPerspectiveFovLH.
    function perspectiveFovLH(fovY: number, aspect: number, nearZ: number, farZ: number): number[] {
        const height = Math.cos(0.5 * fovY) / Math.sin(0.5 * fovY);
        const width = height / aspect;
        const range = farZ / (farZ - nearZ);
        return [width, 0.0, 0.0, 0.0, 0.0, height, 0.0, 0.0, 0.0, 0.0, range, 1.0, 0.0, 0.0, -range * nearZ, 0.0];
    }

    // --- Models -----------------------------------------------------------------------------

    // A SDKMESH model as DirectXTK's Model::CreateFromSDKMESH makes it (core/sdkmesh.cpp parses the
    // file): its vertex and index buffers, its mesh parts (one per subset, drawn with their mesh's
    // buffers), and its materials' diffuse colors and textures.
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
        // Per material: the diffuse color (RGB) and alpha, the diffuse texture (null if none).
        materialColors: number[];
        materialTextures: TextureHandle[];
        vertexStride: int;

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
            this.materialTextures = [];
            this.vertexStride = 0;
        }

        // The file's buffers uploaded by an open command list, its materials' textures loaded
        // (DirectXTK's EffectTextureFactory: DDS files as they are). False (after printing why) on
        // failure.
        load(app: App, commandList: CommandList, file: string): boolean {
            const binaryFile = app.loadBinaryFile(MEDIA_DIR + file);
            if (binaryFile.isNull()) {
                return false;
            }
            const loaded = Donut_LoadSdkMesh(binaryFile.getData(), binaryFile.getSize());
            if (!loaded) {
                app.releaseObject(binaryFile.handle);
                return false;
            }
            const mesh = loaded as Opaque;

            // The sample's models are position, normal and texture coordinates (DirectXTK's
            // VertexPositionNormalTexture layout), which bokeh_scene.hlsl reads.
            this.vertexStride = Donut_GetSdkMeshVertexBufferStride(mesh, 0);
            let ok = true;
            for (let i = 0; i < Donut_GetSdkMeshVertexBufferCount(mesh); i++) {
                if (Donut_GetSdkMeshVertexElementOffset(mesh, i, 3, 0) != 12 || Donut_GetSdkMeshVertexElementOffset(mesh, i, 5, 0) != 24
                    || Donut_GetSdkMeshVertexBufferStride(mesh, i) != this.vertexStride) {
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

            // InitMaterial: a material whose colors are all zero is white.
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
                } else {
                    this.materialColors.push(colors[0]);
                    this.materialColors.push(colors[1]);
                    this.materialColors.push(colors[2]);
                    this.materialColors.push(colors[3] != 1.0 && colors[3] != 0.0 ? colors[3] : 1.0);
                }
                const textureName = Donut_GetSdkMeshMaterialTexture(mesh, m, 0);
                const texture = textureName == "" ? null : app.loadTexture(commandList, MEDIA_DIR + textureName, 0);
                if (!texture) {
                    console.log(`${file}: cannot load the material's texture ${textureName}`);
                    ok = false;
                } else {
                    this.materialTextures.push(texture as TextureHandle);
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

    // --- Passes -----------------------------------------------------------------------------

    // Port of the Xbox ATG Bokeh12 sample (XDKSamples/Graphics/Bokeh12): depth of field rendered
    // with point sprites. The scene (six microscopes around a city) renders into an FP16 target;
    // BokehEffect then copies it with linear depth (RGBZ), downsamples that, and expands a point
    // per 2 x 2 (or 4 x 1) block of the downsampled copy into sprites the size of each pixel's
    // circle of confusion, shaped by an iris texture, in a geometry shader, additively into near
    // and far layers at three resolutions (six viewports of one target); the layers and the
    // in-focus scene are recombined, and the result copied to the back buffer. A compute shader
    // finds the iris texture's energy weights every frame, as the sample.
    //
    // The sample's gamepad controls are keys here (see UserInterface); its HUD's timings are the
    // GPU's, as its GPUTimer's.
    class BokehPass {
        private app: App;
        private models: Model[];
        private irisTexture: TextureHandle;
        private energiesTexture: TextureHandle;
        private scratchBuffer: BufferHandle;
        private anisotropicSampler: SamplerHandle;
        private bokehSampler: SamplerHandle;
        private bilinearBorderSampler: SamplerHandle;
        private bokehBuffer: BufferHandle;
        private parametersBuffer: BufferHandle;
        private bokehConstants: f32[];
        private parameters: f32[];
        private sceneLayout: BindingLayoutHandle;
        private rgbzLayout: BindingLayoutHandle;
        private downsampleLayout: BindingLayoutHandle;
        private quadPointLayout: BindingLayoutHandle;
        private recombineLayout: BindingLayoutHandle;
        private copyLayout: BindingLayoutHandle;
        private energyLayout: BindingLayoutHandle;
        private inputLayout: InputLayoutHandle;
        private sceneVS: ShaderHandle;
        private scenePS: ShaderHandle;
        private quadVS: ShaderHandle;
        private createRgbzPS: ShaderHandle;
        private downsampleRgbzPS: ShaderHandle;
        private quadPointVS: ShaderHandle;
        private quadPointGS: ShaderHandle;
        private quadPointFastGS: ShaderHandle;
        private quadPointPS: ShaderHandle;
        private recombinePS: ShaderHandle;
        private copyPS: ShaderHandle;
        private energyPipeline: Opaque;
        private energyBindingSet: BindingSet;
        private objectBindingSets: BindingSet[];
        // Frame-sized, made on the first frame and after each resize.
        private sceneColor: TextureHandle | null;
        private sceneDepth: TextureHandle | null;
        private dofColor: TextureHandle | null;
        private rgbzCopy: TextureHandle | null;
        private rgbzHalfCopy: TextureHandle | null;
        private sceneFramebuffer: Opaque | null;
        private sceneColorFramebuffer: Opaque | null;
        private dofFramebuffer: Opaque | null;
        private rgbzFramebuffer: Opaque | null;
        private rgbzHalfFramebuffer: Opaque | null;
        private rgbzBindingSet: BindingSet;
        private downsampleBindingSet: BindingSet;
        private quadPointBindingSet: BindingSet;
        private recombineBindingSet: BindingSet;
        private copyBindingSet: BindingSet;
        // Made once, on the first frame.
        private scenePipeline: Opaque | null;
        private rgbzPipeline: Opaque | null;
        private downsamplePipeline: Opaque | null;
        private quadPointPipeline: Opaque | null;
        private quadPointFastPipeline: Opaque | null;
        private recombinePipeline: Opaque | null;
        private copyPipeline: Opaque | null;
        private dofHeight: int;
        private timers: Opaque[];
        private timerPending: boolean[];
        private timerFrame: int;
        private timerSums: number[];
        private timerSamples: int;
        private timerWindow: number;

        frameWidth: int;
        frameHeight: int;
        // The HUD's numbers: CPU frame time and GPU times (frame, scene, bokeh, copy) in ms.
        cpuFrameMs: number;
        gpuMs: number[];

        // ATG::BokehEffect::Parameters and the camera.
        focusLength: number;
        fNumber: number;
        focalPlane: number;
        maxCoCSizeNear: number;
        maxCoCSizeFar: number;
        switchover1: number[];
        switchover2: number[];
        initialEnergyScale: number;
        useFastShader: boolean;
        presetScene: int;
        cameraAngle: number;
        cameraElevation: number;
        cameraDistance: number;

        // Held keys: the gamepad's sticks, shoulder buttons and triggers, D-pad left and right.
        private held: boolean[];

        constructor(app: App) {
            this.app = app;
            this.models = [];
            this.bokehConstants = [];
            for (let i = 0; i < BOKEH_CB_FLOATS + 4; i++) {
                this.bokehConstants.push(0.0);
            }
            this.parameters = [];
            for (let i = 0; i < PARAMETERS_SLICE_FLOATS * OBJECT_COUNT; i++) {
                this.parameters.push(0.0);
            }
            this.energyBindingSet = new BindingSet(null);
            this.objectBindingSets = [];
            this.sceneColor = null;
            this.sceneDepth = null;
            this.dofColor = null;
            this.rgbzCopy = null;
            this.rgbzHalfCopy = null;
            this.sceneFramebuffer = null;
            this.sceneColorFramebuffer = null;
            this.dofFramebuffer = null;
            this.rgbzFramebuffer = null;
            this.rgbzHalfFramebuffer = null;
            this.rgbzBindingSet = new BindingSet(null);
            this.downsampleBindingSet = new BindingSet(null);
            this.quadPointBindingSet = new BindingSet(null);
            this.recombineBindingSet = new BindingSet(null);
            this.copyBindingSet = new BindingSet(null);
            this.scenePipeline = null;
            this.rgbzPipeline = null;
            this.downsamplePipeline = null;
            this.quadPointPipeline = null;
            this.quadPointFastPipeline = null;
            this.recombinePipeline = null;
            this.copyPipeline = null;
            this.dofHeight = 0;
            this.timers = [];
            this.timerPending = [];
            for (let i = 0; i < TIMER_FRAMES; i++) {
                this.timerPending.push(false);
            }
            this.timerFrame = 0;
            this.timerSums = [0.0, 0.0, 0.0, 0.0];
            this.timerSamples = 0;
            this.timerWindow = 0.0;
            this.frameWidth = 1280;
            this.frameHeight = 720;
            this.cpuFrameMs = 0.0;
            this.gpuMs = [0.0, 0.0, 0.0, 0.0];

            // Sample::Sample: performance / quality tradeoff
            this.maxCoCSizeNear = 32.0;       // maximum allowed radius
            this.maxCoCSizeFar = 32.0;
            this.switchover1 = [16.0, 16.0];  // near/far 1/2 -> 1/4 switchover threshold in pixels (radius)
            this.switchover2 = [16.0, 16.0];  // near 1/4 -> 1/8
            // edges blend
            this.initialEnergyScale = 1.72;
            this.useFastShader = true;
            this.focusLength = 0.075;
            this.fNumber = 2.8;
            this.focalPlane = 0.5;
            this.presetScene = 0;
            this.cameraAngle = 0.0;
            this.cameraElevation = 5.0;
            this.cameraDistance = 5.0;
            this.held = [];
            for (let i = 0; i < 512; i++) {
                this.held.push(false);
            }
            this.setPredefinedScene(0);
        }

        // Sample::SetPredefinedScene.
        setPredefinedScene(index: int): void {
            if (index == 1) {
                // default scene
                this.focusLength = 0.075;    // 75 mm lens
                this.fNumber = 2.8;          // F/2.8 aperture
                this.focalPlane = 2.5;       // focus distance
                this.cameraAngle = -0.8;     // radians
                this.cameraElevation = 0.8;
                this.cameraDistance = 2.3;
            } else if (index == 2) {
                // defocused background
                this.focusLength = 0.075;    // 75 mm lens
                this.fNumber = 2.8;          // F/2.8 aperture
                this.focalPlane = 1.0;       // focus distance
                this.cameraAngle = -2.4;     // radians
                this.cameraElevation = 0.8;
                this.cameraDistance = 2.5;
            } else if (index == 3) {
                // doll house
                this.focusLength = 0.175;    // 175 mm lens
                this.fNumber = 2.8;          // F/2.8 aperture
                this.focalPlane = 2.5;       // focus distance
                this.cameraAngle = -1.28;    // radians
                this.cameraElevation = 0.8;
                this.cameraDistance = 3.1;
            } else {
                // macro scene
                this.focusLength = 0.075;    // 75 mm lens
                this.fNumber = 2.8;          // F/2.8 aperture
                this.focalPlane = 0.5;       // focus distance
                this.cameraAngle = -0.8;     // radians
                this.cameraElevation = 0.8;
                this.cameraDistance = 1.1;
            }
        }

        onKey(key: int, scancode: int, action: int, mods: int): int {
            if (key >= 0 && key < 512) {
                this.held[key] = action != ACTION_RELEASE;
            }
            if (action == ACTION_PRESS) {
                if (key == KEY_UP) {
                    // Toggle fast bokeh shader
                    this.useFastShader = !this.useFastShader;
                } else if (key == KEY_DOWN) {
                    // Iterate through preset parameters & cam position
                    this.presetScene = (this.presetScene + 1) % PRESET_SCENE_COUNT;
                    this.setPredefinedScene(this.presetScene);
                }
            }
            return 1;
        }

        isHeld(key: int): boolean {
            return this.held[key];
        }

        // A stick axis from two keys: 1, -1 or 0.
        axis(positiveKey: int, negativeKey: int): number {
            let value = 0.0;
            if (this.held[positiveKey]) {
                value += 1.0;
            }
            if (this.held[negativeKey]) {
                value -= 1.0;
            }
            return value;
        }

        // Sample::Update: the held controls, a step per 1/60 s.
        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
            this.cpuFrameMs = 1000.0 * elapsedSeconds;
            const steps = elapsedSeconds * STEPS_PER_SECOND;

            // The left stick (A / D, W / S) and the right stick's Y (Q / E).
            const leftX = this.axis(KEY_D, KEY_A);
            const leftY = this.axis(KEY_W, KEY_S);
            const rightY = this.axis(KEY_Q, KEY_E);
            this.cameraAngle -= leftX * 0.2 * steps;
            this.cameraElevation = Math.max(-10.0, Math.min(10.0, this.cameraElevation - leftY * 0.2 * steps));
            this.cameraDistance = Math.max(1.0, Math.min(10.0, this.cameraDistance - rightY * 0.2 * steps));

            // Focus Length
            if (this.isHeld(KEY_LEFT)) {
                // longest super telephoto Canon F/11 lens is 1.2 meter
                // so let's limit it to 200mm because even that can produce blurs of radius of 100+ in the near plane
                this.focusLength = Math.min(0.2, this.focusLength + 0.01 * steps);
            }
            if (this.isHeld(KEY_RIGHT)) {
                this.focusLength = Math.max(0.025, this.focusLength - 0.01 * steps);
            }

            // FNumber: [A] 2, [B] 1.
            if (this.isHeld(KEY_1 + 1)) {
                this.fNumber = Math.min(64.0, this.fNumber + 0.1 * steps);
            }
            if (this.isHeld(KEY_1)) {
                this.fNumber = Math.max(1.0, this.fNumber - 0.1 * steps);
            }

            // Focal Plane: [Y] 4, [X] 3.
            if (this.isHeld(KEY_1 + 3)) {
                this.focalPlane = Math.min(10.0, this.focalPlane + 0.01 * steps);
            }
            if (this.isHeld(KEY_1 + 2)) {
                this.focalPlane = Math.max(0.5, this.focalPlane - 0.01 * steps);
            }

            // Max Near CoC Size: [LB] 5, [LT] 6.
            if (this.isHeld(KEY_1 + 4)) {
                this.maxCoCSizeNear = Math.max(1.0, this.maxCoCSizeNear - 1.0 * steps);
            }
            if (this.isHeld(KEY_1 + 5)) {
                this.maxCoCSizeNear = Math.min(128.0, this.maxCoCSizeNear + 1.0 * steps);
            }

            // Max Far CoC Size: [RB] 7, [RT] 8.
            if (this.isHeld(KEY_1 + 6)) {
                this.maxCoCSizeFar = Math.max(1.0, this.maxCoCSizeFar - 1.0 * steps);
            }
            if (this.isHeld(KEY_1 + 7)) {
                this.maxCoCSizeFar = Math.min(128.0, this.maxCoCSizeFar + 1.0 * steps);
            }

            // GPUTimer's averages, over half a second here.
            this.timerWindow += elapsedSeconds;
            if (this.timerWindow >= 0.5 && this.timerSamples > 0) {
                for (let i = 0; i < TIMER_COUNT; i++) {
                    this.gpuMs[i] = this.timerSums[i] / this.timerSamples;
                    this.timerSums[i] = 0.0;
                }
                this.timerSamples = 0;
                this.timerWindow = 0.0;
            }
        }

        releaseFrameResources(): void {
            const sets = [this.rgbzBindingSet, this.downsampleBindingSet, this.quadPointBindingSet, this.recombineBindingSet,
                this.copyBindingSet];
            for (let i = 0; i < sets.length; i++) {
                if (!sets[i].isNull()) {
                    this.app.releaseResource(sets[i].handle);
                }
            }
            this.rgbzBindingSet = new BindingSet(null);
            this.downsampleBindingSet = new BindingSet(null);
            this.quadPointBindingSet = new BindingSet(null);
            this.recombineBindingSet = new BindingSet(null);
            this.copyBindingSet = new BindingSet(null);

            const framebuffers: (ResourceHandle | null)[] = [this.sceneFramebuffer, this.sceneColorFramebuffer,
                this.dofFramebuffer, this.rgbzFramebuffer, this.rgbzHalfFramebuffer, this.sceneColor, this.sceneDepth,
                this.dofColor, this.rgbzCopy, this.rgbzHalfCopy];
            for (let i = 0; i < framebuffers.length; i++) {
                const resource = framebuffers[i];
                if (resource) {
                    this.app.releaseResource(resource);
                }
            }
            this.sceneFramebuffer = null;
            this.sceneColorFramebuffer = null;
            this.dofFramebuffer = null;
            this.rgbzFramebuffer = null;
            this.rgbzHalfFramebuffer = null;
            this.sceneColor = null;
            this.sceneDepth = null;
            this.dofColor = null;
            this.rgbzCopy = null;
            this.rgbzHalfCopy = null;
        }

        onBackBufferResizing(): void {
            this.releaseFrameResources();
        }

        // Sample::CreateWindowSizeDependentResources and BokehEffect::ResizeResources: the scene's
        // FP16 color and depth, the DOF target (the layers' six viewports: two at a quarter of the
        // size one below the other, two at a sixteenth and two at a 64th along the bottom), and
        // the RGBZ copies at full and quarter size.
        createFrameResources(width: int, height: int): void {
            this.sceneColor = this.app.createRenderTargetTexture(width, height, Format.RGBA16_FLOAT, "SceneColor");
            this.sceneDepth = this.app.createDepthTexture(width, height, Format.D32, 1.0, "SceneDepth");
            this.dofHeight = Math.floor(2 * height / FIRST_DOWNSAMPLE) + Math.floor(height / (2 * FIRST_DOWNSAMPLE))
                + Math.floor(height / (4 * FIRST_DOWNSAMPLE));
            this.dofColor = this.app.createRenderTargetTexture(width, this.dofHeight, Format.RGBA16_FLOAT, "DOFColorTexture");
            this.rgbzCopy = this.app.createRenderTargetTexture(width, height, Format.RGBA16_FLOAT, "SourceColorTextureRGBZCopy");
            this.rgbzHalfCopy = this.app.createRenderTargetTexture(Math.floor(width / FIRST_DOWNSAMPLE), Math.floor(height / FIRST_DOWNSAMPLE),
                Format.RGBA16_FLOAT, "SourceColorTextureRGBZHalfCopy");
            const sceneColor = this.sceneColor as TextureHandle;
            const sceneDepth = this.sceneDepth as TextureHandle;
            const dofColor = this.dofColor as TextureHandle;
            const rgbzCopy = this.rgbzCopy as TextureHandle;
            const rgbzHalfCopy = this.rgbzHalfCopy as TextureHandle;
            this.sceneFramebuffer = this.app.createFramebuffer(sceneColor, sceneDepth);
            this.sceneColorFramebuffer = this.app.createFramebuffer(sceneColor, null);
            this.dofFramebuffer = this.app.createFramebuffer(dofColor, null);
            this.rgbzFramebuffer = this.app.createFramebuffer(rgbzCopy, null);
            this.rgbzHalfFramebuffer = this.app.createFramebuffer(rgbzHalfCopy, null);

            // The sample's descriptor tables, as each pass binds them.
            const rgbzDesc = BindingSetDesc.create();
            rgbzDesc.bindEntireConstantBuffer(0, this.bokehBuffer);
            rgbzDesc.bindTextureSRV(0, sceneColor);
            rgbzDesc.bindTextureSRV(2, sceneDepth);
            rgbzDesc.bindSampler(0, this.bokehSampler);
            this.rgbzBindingSet = this.app.createBindingSetForLayout(rgbzDesc, this.rgbzLayout);

            const downsampleDesc = BindingSetDesc.create();
            downsampleDesc.bindEntireConstantBuffer(0, this.bokehBuffer);
            downsampleDesc.bindTextureSRV(0, rgbzCopy);
            downsampleDesc.bindSampler(0, this.bokehSampler);
            this.downsampleBindingSet = this.app.createBindingSetForLayout(downsampleDesc, this.downsampleLayout);

            const quadPointDesc = BindingSetDesc.create();
            quadPointDesc.bindEntireConstantBuffer(0, this.bokehBuffer);
            quadPointDesc.bindTextureSRV(0, rgbzHalfCopy);
            quadPointDesc.bindTextureSRV(1, this.irisTexture);
            quadPointDesc.bindTextureSRV(4, this.energiesTexture);
            quadPointDesc.bindSampler(0, this.bokehSampler);
            this.quadPointBindingSet = this.app.createBindingSetForLayout(quadPointDesc, this.quadPointLayout);

            const recombineDesc = BindingSetDesc.create();
            recombineDesc.bindEntireConstantBuffer(0, this.bokehBuffer);
            recombineDesc.bindTextureSRV(0, dofColor);
            recombineDesc.bindTextureSRV(2, sceneDepth);
            recombineDesc.bindTextureSRV(3, rgbzCopy);
            recombineDesc.bindSampler(0, this.bokehSampler);
            this.recombineBindingSet = this.app.createBindingSetForLayout(recombineDesc, this.recombineLayout);

            const copyDesc = BindingSetDesc.create();
            copyDesc.bindTextureSRV(0, sceneColor);
            this.copyBindingSet = this.app.createBindingSetForLayout(copyDesc, this.copyLayout);
        }

        // The full-screen passes: no depth, nothing culled (the triangles face the camera anyway).
        fullScreenDesc(pixelShader: ShaderHandle, layout: BindingLayoutHandle): GraphicsPipelineDesc {
            const desc = GraphicsPipelineDesc.create(this.quadVS, pixelShader);
            desc.addBindingLayout(layout);
            desc.setDepthState(0, 0, ComparisonFunc.Always);
            desc.setRasterState(CullMode.None, FillMode.Solid, 0);
            return desc;
        }

        // BokehEffect::CreatePSO and the scene's EffectPipelineStateDescription.
        createPipelines(frame: Frame): void {
            // Opaque, DepthDefault (less or equal), CullCounterClockwise.
            const sceneDesc = GraphicsPipelineDesc.create(this.sceneVS, this.scenePS);
            sceneDesc.addBindingLayout(this.sceneLayout);
            sceneDesc.setInputLayout(this.inputLayout);
            sceneDesc.setDepthState(1, 1, ComparisonFunc.LessOrEqual);
            sceneDesc.setRasterState(CullMode.Back, FillMode.Solid, 0);
            this.scenePipeline = this.app.createGraphicsPipelineFromDesc(sceneDesc, this.sceneFramebuffer as Opaque);

            this.rgbzPipeline = this.app.createGraphicsPipelineFromDesc(this.fullScreenDesc(this.createRgbzPS, this.rgbzLayout),
                this.rgbzFramebuffer as Opaque);
            this.downsamplePipeline = this.app.createGraphicsPipelineFromDesc(
                this.fullScreenDesc(this.downsampleRgbzPS, this.downsampleLayout), this.rgbzHalfFramebuffer as Opaque);
            this.recombinePipeline = this.app.createGraphicsPipelineFromDesc(
                this.fullScreenDesc(this.recombinePS, this.recombineLayout), this.sceneColorFramebuffer as Opaque);
            this.copyPipeline = this.app.createGraphicsPipelineFromDescForFrame(this.fullScreenDesc(this.copyPS, this.copyLayout), frame);

            // The quad point PSOs: points expanded by the geometry shader, added together (One + One).
            for (let i = 0; i < 2; i++) {
                const desc = GraphicsPipelineDesc.create(this.quadPointVS, this.quadPointPS);
                desc.setGeometryShader(i == 0 ? this.quadPointGS : this.quadPointFastGS);
                desc.addBindingLayout(this.quadPointLayout);
                desc.setPrimitiveType(PrimitiveType.PointList);
                desc.setDepthState(0, 0, ComparisonFunc.Always);
                desc.setRasterState(CullMode.None, FillMode.Solid, 0);
                desc.setBlendState(1, BlendFactor.One, BlendFactor.One, BlendOp.Add, BlendFactor.One, BlendFactor.One, BlendOp.Add);
                const pipeline = this.app.createGraphicsPipelineFromDesc(desc, this.dofFramebuffer as Opaque);
                if (i == 0) {
                    this.quadPointPipeline = pipeline;
                } else {
                    this.quadPointFastPipeline = pipeline;
                }
            }
        }

        // Sample::CalculateCameraMatrix and Model::UpdateEffectMatrices: each object's BasicEffect
        // constants (EffectMatrices and EffectLights::SetConstants: ambient folded into emissive,
        // diffuse premultiplied by alpha; the sample sets every effect's emissive color to white).
        updateScene(view: number[], proj: number[]): void {
            const viewInverse = inverse(view);
            for (let o = 0; o < OBJECT_COUNT; o++) {
                const model = this.models[OBJECT_MODELS[o]];
                const base = o * PARAMETERS_SLICE_FLOATS;
                // One material per model in the sample's files.
                const alpha = model.materialColors[3];
                for (let i = 0; i < 3; i++) {
                    const diffuse = model.materialColors[i];
                    this.parameters[base + i] = Math.fround(diffuse * alpha);
                    this.parameters[base + PARAMETERS_EMISSIVE + i] = Math.fround((DEFAULT_AMBIENT[i] * diffuse + 1.0) * alpha);
                    // DisableSpecular: black, power 1.
                    this.parameters[base + PARAMETERS_SPECULAR + i] = 0.0;
                }
                this.parameters[base + 3] = alpha;
                this.parameters[base + PARAMETERS_SPECULAR + 3] = 1.0;
                for (let light = 0; light < 3; light++) {
                    for (let i = 0; i < 3; i++) {
                        this.parameters[base + PARAMETERS_LIGHTS + light * 4 + i] = DEFAULT_DIRECTIONS[light * 3 + i];
                        this.parameters[base + PARAMETERS_LIGHTS + 12 + light * 4 + i] = DEFAULT_DIFFUSE[light * 3 + i];
                        this.parameters[base + PARAMETERS_LIGHTS + 24 + light * 4 + i] = DEFAULT_SPECULAR[light * 3 + i];
                    }
                }
                for (let i = 0; i < 3; i++) {
                    this.parameters[base + PARAMETERS_EYE + i] = viewInverse[12 + i];
                }

                const world = rotationY(Math.fround(Math.fround(2.0 * Math.PI) * Math.fround(OBJECT_TURNS[o] / 6.0)));
                const worldInverseTranspose = transpose(inverse(world));
                const worldViewProj = multiply(multiply(world, view), proj);
                for (let i = 0; i < 16; i++) {
                    this.parameters[base + PARAMETERS_WORLD + i] = world[i];
                    this.parameters[base + PARAMETERS_WORLD_INVERSE_TRANSPOSE + i] = worldInverseTranspose[i];
                    this.parameters[base + PARAMETERS_WORLD_VIEW_PROJ + i] = worldViewProj[i];
                }
            }
        }

        // BokehEffect::StartRendering's constants.
        updateBokehConstants(width: int, height: int, invProj: number[]): void {
            const c = this.bokehConstants;
            c[0] = this.maxCoCSizeNear;
            c[1] = this.focusLength;
            c[2] = this.focalPlane;
            c[3] = this.fNumber;
            c[4] = width;
            c[5] = height;
            c[6] = width;
            c[7] = this.dofHeight;
            c[8] = width;
            c[9] = height;
            c[10] = this.maxCoCSizeFar;
            // 0.5 / the iris texture's width (32).
            c[11] = 0.5 / 32.0;
            for (let i = 0; i < 6; i++) {
                c[BOKEH_CB_VIEWPORTS + i * 4] = this.viewportValue(i, 0, width, height);
                c[BOKEH_CB_VIEWPORTS + i * 4 + 1] = this.viewportValue(i, 1, width, height);
                c[BOKEH_CB_VIEWPORTS + i * 4 + 2] = this.viewportValue(i, 2, width, height);
                c[BOKEH_CB_VIEWPORTS + i * 4 + 3] = this.viewportValue(i, 3, width, height);
            }
            c[BOKEH_CB_SWITCHOVER] = this.switchover1[0];
            c[BOKEH_CB_SWITCHOVER + 1] = this.switchover1[1];
            c[BOKEH_CB_SWITCHOVER + 2] = this.switchover2[0];
            c[BOKEH_CB_SWITCHOVER + 3] = this.switchover2[1];
            c[BOKEH_CB_ENERGY_SCALE] = this.initialEnergyScale;
            // XMMatrixTranspose(matInvProj), read by the shader's column-major matrix.
            const invProjT = transpose(invProj);
            for (let i = 0; i < 16; i++) {
                c[BOKEH_CB_INV_PROJ + i] = invProjT[i];
            }
        }

        // BokehEffect::StartRendering's output viewports: x, y, width, height (which 0..3).
        viewportValue(index: int, which: int, width: int, height: int): number {
            const vpSx = Math.fround(width / FIRST_DOWNSAMPLE);
            const vpSy = Math.fround(height / FIRST_DOWNSAMPLE);
            const vpSx2 = Math.fround(width / (2 * FIRST_DOWNSAMPLE));
            const vpSy2 = Math.fround(height / (2 * FIRST_DOWNSAMPLE));
            const vpSx4 = Math.fround(width / (4 * FIRST_DOWNSAMPLE));
            const vpSy4 = Math.fround(height / (4 * FIRST_DOWNSAMPLE));
            let x = 0.0;
            let y = 0.0;
            let w = vpSx;
            let h = vpSy;
            if (index == 1) {
                y = vpSy;
            } else if (index == 2 || index == 3) {
                x = index == 3 ? vpSx2 : 0.0;
                y = Math.fround(vpSy * 2.0);
                w = vpSx2;
                h = vpSy2;
            } else if (index == 4 || index == 5) {
                x = index == 5 ? vpSx4 : 0.0;
                y = Math.fround(Math.fround(vpSy * 2.0) + vpSy2);
                w = vpSx4;
                h = vpSy4;
            }
            return which == 0 ? x : which == 1 ? y : which == 2 ? w : h;
        }

        // The timers of TIMER_FRAMES frames ago, read back and averaged; this frame's reset.
        readTimers(): void {
            const first = this.timerFrame * TIMER_COUNT;
            if (this.timerPending[this.timerFrame]) {
                for (let i = 0; i < TIMER_COUNT; i++) {
                    this.timerSums[i] += this.app.getTimerQueryTime(this.timers[first + i]) * 1000.0;
                }
                this.timerSamples++;
            }
            for (let i = 0; i < TIMER_COUNT; i++) {
                this.app.resetTimerQuery(this.timers[first + i]);
            }
            this.timerPending[this.timerFrame] = true;
        }

        timer(index: int): Opaque {
            return this.timers[this.timerFrame * TIMER_COUNT + index];
        }

        // Sample::Render: the scene, the bokeh effect, the copy to the back buffer (the HUD is the
        // ImGui pass's).
        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();
            if (width != this.frameWidth || height != this.frameHeight) {
                this.releaseFrameResources();
            }
            this.frameWidth = width;
            this.frameHeight = height;
            if (!this.sceneColor) {
                this.createFrameResources(width, height);
            }
            if (!this.scenePipeline) {
                this.createPipelines(frame);
            }

            // Sample::CalculateCameraMatrix
            const eye = [Math.fround(Math.sin(this.cameraAngle)) * this.cameraDistance, this.cameraElevation,
                Math.fround(Math.cos(this.cameraAngle)) * this.cameraDistance];
            const view = lookAtLH(eye, [0.0, 0.0, 0.0], [0.0, 1.0, 0.0]);
            const proj = perspectiveFovLH(Math.PI / 4.0, width / height, 0.05, 100.0);
            this.updateScene(view, proj);
            this.updateBokehConstants(width, height, inverse(proj));
            commandList.writeBuffer(this.parametersBuffer, Ref(this.parameters[0]), PARAMETERS_SLICE_FLOATS * OBJECT_COUNT * 4);
            commandList.writeBuffer(this.bokehBuffer, Ref(this.bokehConstants[0]), (BOKEH_CB_FLOATS + 4) * 4);

            this.readTimers();
            commandList.beginTimerQuery(this.timer(TI_FRAME));

            //------------------------------
            // Scene
            const sceneColor = this.sceneColor as TextureHandle;
            commandList.clearTextureFloat(sceneColor, 0.0, 0.0, 0.0, 0.0);
            commandList.clearDepth(this.sceneDepth as TextureHandle, 1.0);
            commandList.beginTimerQuery(this.timer(TI_SCENE));
            // render the city and microscopes
            for (let o = 0; o < OBJECT_COUNT; o++) {
                const model = this.models[OBJECT_MODELS[o]];
                for (let p = 0; p < model.partIndexCounts.length; p++) {
                    frame.beginDrawToFramebuffer(this.scenePipeline as Opaque, this.sceneFramebuffer as Opaque);
                    frame.drawAddBindingSet(this.objectBindingSets[o]);
                    frame.drawAddVertexBuffer(model.vertexBuffers[model.partVertexBuffers[p]], 0, 0);
                    const ib = model.partIndexBuffers[p];
                    if (model.index32[ib]) {
                        frame.drawSetIndexBuffer(model.indexBuffers[ib]);
                    } else {
                        frame.drawSetIndexBuffer16(model.indexBuffers[ib]);
                    }
                    frame.drawIndexedRange(model.partIndexCounts[p], model.partStartIndices[p], model.partVertexOffsets[p]);
                }
            }
            commandList.endTimerQuery(this.timer(TI_SCENE));

            //------------------------------
            // Bokeh
            commandList.beginTimerQuery(this.timer(TI_BOKEH));

            // find iris texture weights
            commandList.dispatch(this.energyPipeline, this.energyBindingSet, NUM_RADII_WEIGHTS / 8, NUM_RADII_WEIGHTS / 8, NUM_RADII_WEIGHTS);

            commandList.clearTextureFloat(this.dofColor as TextureHandle, 0.0, 0.0, 0.0, 0.0);

            // copy out the source
            frame.beginDrawToFramebuffer(this.rgbzPipeline as Opaque, this.rgbzFramebuffer as Opaque);
            frame.drawAddBindingSet(this.rgbzBindingSet);
            frame.drawVertices(3);

            // downsample
            frame.beginDrawToFramebuffer(this.downsamplePipeline as Opaque, this.rgbzHalfFramebuffer as Opaque);
            frame.drawAddBindingSet(this.downsampleBindingSet);
            frame.drawVertices(3);

            // prepare the multi-viewport dof render target: split into slices, do the CoC DOF
            frame.beginDrawToFramebuffer((this.useFastShader ? this.quadPointFastPipeline : this.quadPointPipeline) as Opaque,
                this.dofFramebuffer as Opaque);
            frame.drawAddBindingSet(this.quadPointBindingSet);
            for (let i = 0; i < 6; i++) {
                frame.drawAddViewport(this.viewportValue(i, 0, width, height), this.viewportValue(i, 1, width, height),
                    this.viewportValue(i, 2, width, height), this.viewportValue(i, 3, width, height));
            }
            // each GS can output up to 4 triangles
            frame.drawVertices(Math.floor(width * height / (FIRST_DOWNSAMPLE * FIRST_DOWNSAMPLE * 2 * 2)));

            // combine the resulting viewports
            frame.beginDrawToFramebuffer(this.recombinePipeline as Opaque, this.sceneColorFramebuffer as Opaque);
            frame.drawAddBindingSet(this.recombineBindingSet);
            frame.drawVertices(3);

            commandList.endTimerQuery(this.timer(TI_BOKEH));

            //------------------------------
            // Copy
            commandList.beginTimerQuery(this.timer(TI_COPY));
            frame.beginDraw(this.copyPipeline as Opaque);
            frame.drawAddBindingSet(this.copyBindingSet);
            frame.drawVertices(3);
            commandList.endTimerQuery(this.timer(TI_COPY));

            commandList.endTimerQuery(this.timer(TI_FRAME));
            this.timerFrame = (this.timerFrame + 1) % TIMER_FRAMES;
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        // Sample::CreateDeviceDependentResources and BokehEffect's resources.
        init(): boolean {
            // CommonRenderPasses (behind the common samplers) opens its own command list: before ours.
            this.anisotropicSampler = this.app.getCommonSampler(CommonSampler.AnisotropicWrap);
            // BokehRS's s0: FILTER_MIN_MAG_LINEAR_MIP_POINT, CreateEnergyTexRS's: FILTER_MIN_MAG_MIP_LINEAR,
            // both bordered in transparent black.
            this.bokehSampler = this.app.createBorderSampler(1, 1, 0, 0.0, 0.0, 0.0, 0.0);
            this.bilinearBorderSampler = this.app.createBorderSampler(1, 1, 1, 0.0, 0.0, 0.0, 0.0);

            this.sceneVS = this.app.createShader("bokeh_scene.hlsl", "scene_vs", ShaderType.Vertex);
            this.scenePS = this.app.createShader("bokeh_scene.hlsl", "scene_ps", ShaderType.Pixel);
            this.quadVS = this.app.createShader("bokeh.hlsl", "quad_vs", ShaderType.Vertex);
            this.createRgbzPS = this.app.createShader("bokeh.hlsl", "create_rgbz_ps", ShaderType.Pixel);
            this.downsampleRgbzPS = this.app.createShader("bokeh.hlsl", "downsample_rgbz_ps", ShaderType.Pixel);
            this.quadPointVS = this.app.createShader("bokeh.hlsl", "quad_point_vs", ShaderType.Vertex);
            this.quadPointGS = this.app.createShaderWithDefine("bokeh.hlsl", "quad_point_gs", ShaderType.Geometry, "OPTIMISE", "0");
            this.quadPointFastGS = this.app.createShaderWithDefine("bokeh.hlsl", "quad_point_gs", ShaderType.Geometry, "OPTIMISE", "1");
            this.quadPointPS = this.app.createShader("bokeh.hlsl", "quad_point_ps", ShaderType.Pixel);
            this.recombinePS = this.app.createShader("bokeh.hlsl", "recombine_ps", ShaderType.Pixel);
            this.copyPS = this.app.createShader("bokeh.hlsl", "copy_ps", ShaderType.Pixel);
            const energyCS = this.app.createShader("bokeh_energy.hlsl", "create_energy_tex_cs", ShaderType.Compute);
            if (!this.sceneVS || !this.scenePS || !this.quadVS || !this.createRgbzPS || !this.downsampleRgbzPS || !this.quadPointVS
                || !this.quadPointGS || !this.quadPointFastGS || !this.quadPointPS || !this.recombinePS || !this.copyPS || !energyCS) {
                return false;
            }

            const sceneLayoutDesc = BindingLayoutDesc.create();
            sceneLayoutDesc.layoutConstantBuffer(0);
            sceneLayoutDesc.layoutTextureSRV(0);
            sceneLayoutDesc.layoutSampler(0);
            this.sceneLayout = this.app.createBindingLayout(sceneLayoutDesc, ShaderType.All);

            const rgbzLayoutDesc = BindingLayoutDesc.create();
            rgbzLayoutDesc.layoutVolatileConstantBuffer(0);
            rgbzLayoutDesc.layoutTextureSRV(0);
            rgbzLayoutDesc.layoutTextureSRV(2);
            rgbzLayoutDesc.layoutSampler(0);
            this.rgbzLayout = this.app.createBindingLayout(rgbzLayoutDesc, ShaderType.All);

            const downsampleLayoutDesc = BindingLayoutDesc.create();
            downsampleLayoutDesc.layoutVolatileConstantBuffer(0);
            downsampleLayoutDesc.layoutTextureSRV(0);
            downsampleLayoutDesc.layoutSampler(0);
            this.downsampleLayout = this.app.createBindingLayout(downsampleLayoutDesc, ShaderType.All);

            const quadPointLayoutDesc = BindingLayoutDesc.create();
            quadPointLayoutDesc.layoutVolatileConstantBuffer(0);
            quadPointLayoutDesc.layoutTextureSRV(0);
            quadPointLayoutDesc.layoutTextureSRV(1);
            quadPointLayoutDesc.layoutTextureSRV(4);
            quadPointLayoutDesc.layoutSampler(0);
            this.quadPointLayout = this.app.createBindingLayout(quadPointLayoutDesc, ShaderType.All);

            const recombineLayoutDesc = BindingLayoutDesc.create();
            recombineLayoutDesc.layoutVolatileConstantBuffer(0);
            recombineLayoutDesc.layoutTextureSRV(0);
            recombineLayoutDesc.layoutTextureSRV(2);
            recombineLayoutDesc.layoutTextureSRV(3);
            recombineLayoutDesc.layoutSampler(0);
            this.recombineLayout = this.app.createBindingLayout(recombineLayoutDesc, ShaderType.All);

            const copyLayoutDesc = BindingLayoutDesc.create();
            copyLayoutDesc.layoutTextureSRV(0);
            this.copyLayout = this.app.createBindingLayout(copyLayoutDesc, ShaderType.All);

            const energyLayoutDesc = BindingLayoutDesc.create();
            energyLayoutDesc.layoutTextureSRV(0);
            energyLayoutDesc.layoutSampler(0);
            energyLayoutDesc.layoutStructuredBufferUAV(0);
            energyLayoutDesc.layoutTextureUAV(1);
            this.energyLayout = this.app.createBindingLayout(energyLayoutDesc, ShaderType.Compute);

            this.bokehBuffer = this.app.createVolatileConstantBuffer((BOKEH_CB_FLOATS + 4) * 4, "BokehCB");
            this.parametersBuffer = this.app.createConstantBuffer(PARAMETERS_SLICE_FLOATS * OBJECT_COUNT * 4, "BasicEffect");
            // The 1D weights texture (64 x 1 here) and the energy shader's 8x8x64 scratch memory.
            this.energiesTexture = this.app.createUAVTextureWithFormat(NUM_RADII_WEIGHTS, 1, Format.R32_FLOAT, "EnergiesTex");
            this.scratchBuffer = this.app.createRWStructuredBuffer(4, (NUM_RADII_WEIGHTS / 8) * (NUM_RADII_WEIGHTS / 8) * NUM_RADII_WEIGHTS,
                "ScratchTex");

            // Load models from disk, and the iris texture.
            const commandList = this.app.createCommandList();
            commandList.open();
            let loaded = true;
            for (let i = 0; i < MODEL_FILES.length; i++) {
                const model = new Model();
                if (!model.load(this.app, commandList, MODEL_FILES[i])) {
                    loaded = false;
                }
                this.models.push(model);
            }
            const irisTexture = this.app.loadTexture(commandList, MEDIA_DIR + "irishexa32.dds", 0);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!loaded || !irisTexture) {
                console.log("Cannot load the sample's models and textures: set XBOX_ATG_SAMPLES_DIR when configuring");
                return false;
            }
            this.irisTexture = irisTexture as TextureHandle;

            // The models' vertices: position, normal, texture coordinates.
            const stride = this.models[0].vertexStride;
            const inputLayoutDesc = InputLayoutDesc.create();
            inputLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, stride);
            inputLayoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, 12, 0, stride);
            inputLayoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 24, 0, stride);
            this.inputLayout = this.app.createInputLayout(inputLayoutDesc, this.sceneVS);

            // Each object's BasicEffect: its constants and its model's texture.
            for (let o = 0; o < OBJECT_COUNT; o++) {
                const desc = BindingSetDesc.create();
                desc.bindConstantBuffer(0, this.parametersBuffer, o * PARAMETERS_SLICE_FLOATS * 4, PARAMETERS_SLICE_FLOATS * 4);
                desc.bindTextureSRV(0, this.models[OBJECT_MODELS[o]].materialTextures[0]);
                desc.bindSampler(0, this.anisotropicSampler);
                this.objectBindingSets.push(this.app.createBindingSetForLayout(desc, this.sceneLayout));
            }

            const energyDesc = BindingSetDesc.create();
            energyDesc.bindTextureSRV(0, this.irisTexture);
            energyDesc.bindSampler(0, this.bilinearBorderSampler);
            energyDesc.bindStructuredBufferUAV(0, this.scratchBuffer);
            energyDesc.bindTextureUAV(1, this.energiesTexture);
            this.energyBindingSet = this.app.createBindingSetForLayout(energyDesc, this.energyLayout);
            this.energyPipeline = this.app.createComputePipelineWithLayout(energyCS, this.energyLayout);

            for (let i = 0; i < TIMER_FRAMES * TIMER_COUNT; i++) {
                this.timers.push(this.app.createTimerQuery());
            }

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The sample's HUD (SpriteFont text in the title-safe area): its timings at the top, its
    // controls at the bottom, here as keys.
    class UserInterface {
        private sample: BokehPass;

        font: ImGuiFont;

        constructor(sample: BokehPass) {
            this.sample = sample;
        }

        line(x: number, y: number, text: string): void {
            Donut_ImGuiDrawText(x, y, text, GREEN_R, GREEN_G, GREEN_B, 1.0, 0);
        }

        buildUI(): void {
            const sample = this.sample;
            // SimpleMath::Viewport::ComputeTitleSafeArea
            const safeW = Math.fround((sample.frameWidth + 19.0) / 20.0);
            const safeH = Math.fround((sample.frameHeight + 19.0) / 20.0);
            const left: int = Math.floor(safeW);
            const top: int = Math.floor(safeH);
            const bottom: int = Math.floor(sample.frameHeight - safeH + 0.5);

            this.font.push();
            let y = top + 0.0;
            this.line(left, y, "Bokeh Sample");
            y += LINE_SPACING;
            this.line(left, y, `Frame CPU: ${formatFixed(sample.cpuFrameMs, 2)} ms `);
            this.line(left, y + LINE_SPACING, `Frame GPU: ${formatFixed(sample.gpuMs[TI_FRAME], 2)} ms `);
            this.line(left, y + LINE_SPACING * 2.0, `Scene: ${formatFixed(sample.gpuMs[TI_SCENE], 2)} ms `);
            this.line(left, y + LINE_SPACING * 3.0, `Bokeh: ${formatFixed(sample.gpuMs[TI_BOKEH], 2)} ms `);
            this.line(left, y + LINE_SPACING * 4.0, `Final copy: ${formatFixed(sample.gpuMs[TI_COPY], 2)} ms`);

            y = bottom - LINE_SPACING * 8.0;
            this.line(left, y, `[Up]/[Down]   Fast Bokeh: ${sample.useFastShader ? "true" : "false"}, next preset`);
            this.line(left, y + LINE_SPACING, `[Left]/[Right]   Lens: ${formatFixed(sample.focusLength * 1000.0, 2)}mm`);
            this.line(left, y + LINE_SPACING * 2.0, `[2][1] F/${formatFixed(sample.fNumber, 1)}`);
            this.line(left, y + LINE_SPACING * 3.0, `[3][4] Focal Plane: ${formatFixed(sample.focalPlane, 2)}m`);
            this.line(left, y + LINE_SPACING * 4.0, `[5][6] CoC Near: ${formatFixed(sample.maxCoCSizeNear, 1)}`);
            this.line(left, y + LINE_SPACING * 5.0, `[7][8] CoC Far: ${formatFixed(sample.maxCoCSizeFar, 1)}`);
            this.line(left, y + LINE_SPACING * 6.0, "[A][D] [W][S] [Q][E] Camera");
            this.line(left, y + LINE_SPACING * 7.0, "[Esc] Exit");
            Donut_ImGuiPopFont();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App): boolean {
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
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("bokeh");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -preset N: start with preset scene N (0..3; Down cycles them).
        // -slow: start with the full (not the fast) bokeh geometry shader (Up toggles it).
        let options = AppOptions.UnormBackBuffer;
        let preset = 0;
        let slow = false;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = options | AppOptions.DebugRuntime;
            } else if (arg == "-preset" && i + 1 < argc) {
                preset = Math.floor(parseFloat(Donut_GetArg(argv, i + 1)));
                i++;
            } else if (arg == "-slow") {
                slow = true;
            }
        }

        // The sample's R8G8B8A8_UNORM back buffers (its FP16 scene copied as is), in a 1280 x 720
        // window.
        const width = 1280;
        const height = 720;
        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, width, height, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const sample = new BokehPass(app);
        if (!sample.init()) {
            app.destroy();
            return 1;
        }
        const ui = new UserInterface(sample);
        if (!ui.init(app)) {
            app.destroy();
            return 1;
        }
        sample.presetScene = preset % PRESET_SCENE_COUNT;
        sample.setPredefinedScene(sample.presetScene);
        sample.useFastShader = !slow;

        const input = new InputPass(app.handle);

        app.run();
        app.destroy();
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return Bokeh.main(argc, argv);
}

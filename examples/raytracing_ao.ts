// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace RaytracingAo {
    const WINDOW_TITLE = "Donut Example: Raytracing AO";
    const MEDIA_DIR = "media/raytracing_ao/";
    const FONT_PATH = "media/fonts/OpenSans/OpenSans-Regular.ttf";
    // The sample's SegoeUI_18 sprite font, its lines (and measured strings)
    // 32 pixels high.
    // ImGui sizes a font by its ascent + descent (1.3618 OpenSans ems), so the 23 pixel em that gives
    // its strings' widths is 31.5.
    const FONT_SIZE = 31.5;
    const LINE_SPACING = 31.921875;

    // RaytracingAOPC12.cpp.
    const MESH_FILES = ["Dragon.sdkmesh", "Maze1.sdkmesh"];
    const CAM_STEP = 0.1;
    const INITIAL_RADIUS = -20.0;

    // GlobalSharedHlslCompat.h, AORaytracingHlslCompat.h, SSAOHlslCompat.h.
    const NEAR_PLANE = 1.0;
    const FAR_PLANE = 200.0;
    const NOISE_W = 100.0;
    const MAX_OCCLUSION_RAYS = 225;
    const NUM_BUFFERS = 4;
    // The vertices: position, normal, texture coordinates, tangent.
    const VERTEX_STRIDE = 44;

    // SceneConstantBuffer, in floats: worldView, worldViewProjection, projectionToWorld (each
    // transposed), cameraPosition, frustumPoint, frustumHDelta, frustumVDelta, noiseTile.
    const SCENE_FLOATS = 68;
    const SCENE_CAMERA = 48;
    // The SSAO dispatches' constants, a 256-byte slice each: SSAORenderConstantBuffer for the four
    // atlas (tiled) and four downsized (high quality) dispatches, BlurAndUpscaleConstantBuffer for
    // the four blur and upsample ones.
    const SSAO_SLICE_FLOATS = 64;
    const SSAO_TILED_SLICE = 0;
    const SSAO_HIGH_QUALITY_SLICE = 4;
    const SSAO_BLUR_SLICE = 8;
    const SSAO_SLICES = 12;

    // Menus.h: the lighting model shown when not split.
    const LIGHTING_AO = 0;
    const LIGHTING_SSAO = 1;
    const LIGHTING_MODEL_COUNT = 2;
    const MENU_LINE_THICKNESS = 20.0;
    const MENU_BORDER = 20.0;

    // ATG::Colors.
    const OFF_WHITE = 0.635294139;
    const WHITE = 0.980392158;
    const DARK_GREY = 0.200000003;
    const GREEN = [0.062745102, 0.486274511, 0.062745102];
    const ORANGE = [0.764705896, 0.176470593, 0.019607844];

    // GLFW keys.
    const KEY_SPACE = 32;
    const KEY_A = 65;
    const KEY_D = 68;
    const KEY_F = 70;
    const KEY_R = 82;
    const KEY_S = 83;
    const KEY_TAB = 258;
    const KEY_RIGHT = 262;
    const KEY_LEFT = 263;
    const KEY_DOWN = 264;
    const KEY_UP = 265;
    const KEY_F1 = 290;
    const ACTION_RELEASE = 0;
    const ACTION_PRESS = 1;

    // The sample updates once per frame (its timer isn't fixed-step): its per-frame steps are
    // scaled to the frame's time at 60 Hz here.
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

    // GeneralHelper.h's GetNumGrps.
    function numGroups(size: int, threads: int): int {
        return Math.floor((size + threads - 1) / threads);
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

    // XMVector4Transform of (x, y, z, w).
    function transform4(v: number[], m: number[]): number[] {
        let r: number[] = [];
        for (let column = 0; column < 4; column++) {
            r.push(Math.fround(v[0] * m[column] + v[1] * m[4 + column] + v[2] * m[8 + column] + v[3] * m[12 + column]));
        }
        return r;
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
        const height = Math.fround(Math.cos(0.5 * fovY) / Math.sin(0.5 * fovY));
        const width = Math.fround(height / aspect);
        const range = Math.fround(farZ / (farZ - nearZ));
        return [width, 0.0, 0.0, 0.0, 0.0, height, 0.0, 0.0, 0.0, 0.0, range, 1.0, 0.0, 0.0, Math.fround(-range * nearZ), 0.0];
    }

    // --- Menus.h's Option ---------------------------------------------------------------------

    // A menu value, its bounds and step (the sample's float literals, held as doubles).
    class Option {
        start: number;
        current: number;
        min: number;
        max: number;
        inc: number;
        isInt: boolean;

        constructor(start: number, min: number, max: number, inc: number, isInt: boolean) {
            this.start = Math.fround(start);
            this.current = this.start;
            this.min = Math.fround(min);
            this.max = Math.fround(max);
            this.inc = Math.fround(inc);
            this.isInt = isInt;
        }

        increment(): boolean {
            const previous = this.current;
            this.current = Math.min(Math.max(this.current + this.inc, this.min), this.max);
            return previous != this.current;
        }

        decrement(): boolean {
            const previous = this.current;
            this.current = Math.min(Math.max(this.current - this.inc, this.min), this.max);
            return previous != this.current;
        }

        isLowerLimit(): boolean {
            return this.current == this.min;
        }

        isUpperLimit(): boolean {
            return this.current == this.max;
        }

        reset(): void {
            this.current = this.start;
        }

        value(): number {
            return this.current;
        }
    }

    // --- Meshes -------------------------------------------------------------------------------

    // A SDKMESH file as the sample's Mesh loads it (DirectXTK's Model::CreateFromSDKMESH, the
    // frames' transforms not applied): its one opaque part (32-bit indices, triangle list, the
    // sample's 44-byte vertices; its files have one each), uploaded once for rasterization, the
    // hit shader and the acceleration structure build; its material's constants and textures; its
    // BLAS, and a TLAS of one instance of it.
    class Mesh {
        vertexBuffer: BufferHandle;
        indexBuffer: BufferHandle;
        indexCount: int;
        vertexCount: int;
        materialBuffer: BufferHandle;
        diffuseTexture: Opaque;
        specularTexture: Opaque;
        normalTexture: Opaque;
        blas: TriangleBlas;
        topLevelAS: SceneAccelStructs;
        builtTopLevelAS: boolean;

        constructor() {
            this.indexCount = 0;
            this.vertexCount = 0;
            this.builtTopLevelAS = false;
        }

        // A material texture (DirectXTK's EffectTextureFactory: DDS files as they are), or the
        // placeholder for none.
        loadTexture(app: App, commandList: CommandList, name: string, placeholder: Opaque): Opaque | null {
            if (name == "") {
                return placeholder;
            }
            const texture = app.loadTexture(commandList, MEDIA_DIR + name, 0);
            if (!texture) {
                console.log(`Cannot load the material's texture ${name}`);
            }
            return texture;
        }

        // False (after printing why) on failure.
        load(app: App, commandList: CommandList, file: string, placeholder: Opaque): boolean {
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

            // Mesh::Mesh's checks.
            let ok = true;
            if (Donut_GetSdkMeshMeshCount(mesh) != 1 || Donut_GetSdkMeshMeshSubsetCount(mesh, 0) != 1) {
                console.log(`${file}: the port takes meshes of one part`);
                ok = false;
            }
            const subset = Donut_GetSdkMeshMeshSubset(mesh, 0, 0);
            const vb = Donut_GetSdkMeshMeshVertexBuffer(mesh, 0);
            const ib = Donut_GetSdkMeshMeshIndexBuffer(mesh, 0);
            if (Donut_IsSdkMeshIndexBuffer32Bit(mesh, ib) == 0) {
                console.log(`${file}: Only 32bit unsigned int indices can be used for this sample.`);
                ok = false;
            }
            if (Donut_GetSdkMeshSubsetPrimitiveType(mesh, subset) != 0) {
                console.log(`${file}: Only triangle lists are supported for this sample.`);
                ok = false;
            }
            if (Donut_GetSdkMeshVertexBufferStride(mesh, vb) != VERTEX_STRIDE) {
                console.log(`${file}: Vertex format does not mach that of the sample.`);
                ok = false;
            }

            this.vertexBuffer = app.createStaticGeometryBuffer(commandList, Donut_GetSdkMeshVertexBufferData(mesh, vb),
                Donut_GetSdkMeshVertexBufferSize(mesh, vb), 0, file);
            this.indexBuffer = app.createStaticGeometryBuffer(commandList, Donut_GetSdkMeshIndexBufferData(mesh, ib),
                Donut_GetSdkMeshIndexBufferSize(mesh, ib), 1, file);
            this.indexCount = Donut_GetSdkMeshSubsetIndexCount(mesh, subset);
            this.vertexCount = Donut_GetSdkMeshSubsetVertexCount(mesh, subset);

            // DirectXTK's InitMaterial (material colors not sRGB) into MaterialConstantBuffer:
            // ambient, isDiffuseTexture, diffuse, isSpecularTexture, specular, isNormalTexture.
            const material = Donut_GetSdkMeshSubsetMaterial(mesh, subset);
            let colors: f32[] = [];
            for (let i = 0; i < 17; i++) {
                colors.push(0.0);
            }
            Donut_CopySdkMeshMaterialColors(mesh, material, Ref(colors[0]));
            let constants: f32[] = [];
            for (let i = 0; i < 12; i++) {
                constants.push(0.0);
            }
            let uninitialized = true;
            for (let i = 0; i < 8; i++) {
                if (colors[i] != 0.0) {
                    uninitialized = false;
                }
            }
            if (uninitialized) {
                // SDKMESH material color block is uninitalized; assume defaults
                constants[4] = 1.0;
                constants[5] = 1.0;
                constants[6] = 1.0;
            } else {
                for (let i = 0; i < 3; i++) {
                    constants[i] = colors[4 + i];
                    constants[4 + i] = colors[i];
                    if (colors[16] > 0.0) {
                        constants[8 + i] = colors[8 + i];
                    }
                }
            }
            const diffuseName = Donut_GetSdkMeshMaterialTexture(mesh, material, 0);
            const specularName = Donut_GetSdkMeshMaterialTexture(mesh, material, 2);
            const normalName = Donut_GetSdkMeshMaterialTexture(mesh, material, 1);
            Donut_StoreInt32(Ref(constants[3]), diffuseName != "" ? 1 : 0);
            Donut_StoreInt32(Ref(constants[7]), specularName != "" ? 1 : 0);
            Donut_StoreInt32(Ref(constants[11]), normalName != "" ? 1 : 0);
            this.materialBuffer = app.createConstantBuffer(256, "MaterialConstantBuffer");
            commandList.writeBuffer(this.materialBuffer, Ref(constants[0]), 48);

            const diffuse = this.loadTexture(app, commandList, diffuseName, placeholder);
            const specular = this.loadTexture(app, commandList, specularName, placeholder);
            const normal = this.loadTexture(app, commandList, normalName, placeholder);
            if (!diffuse || !specular || !normal) {
                ok = false;
            } else {
                this.diffuseTexture = diffuse as Opaque;
                this.specularTexture = specular as Opaque;
                this.normalTexture = normal as Opaque;
            }

            // AO::BuildAccelerationStructures: opaque geometry, preferring fast tracing.
            this.blas = app.createEmptyTriangleBlas(file);
            this.blas.addGeometry(this.indexBuffer, 0, this.indexCount, this.vertexBuffer, 0, this.vertexCount, VERTEX_STRIDE, null);
            if (this.blas.build(app, commandList, AccelStructBuildFlags.PreferFastTrace) == 0) {
                ok = false;
            }
            this.topLevelAS = app.createTopLevelASWithFlags(1, AccelStructBuildFlags.PreferFastTrace);
            if (this.topLevelAS.isNull()) {
                ok = false;
            }

            Donut_DestroySdkMesh(mesh);
            app.releaseObject(binaryFile.handle);
            return ok;
        }

        // The sample's one instance: identity transform, mask 1. Valid in a render callback.
        buildTopLevelAS(frame: Frame): void {
            if (this.builtTopLevelAS) {
                return;
            }
            let transform: f32[] = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0];
            this.topLevelAS.addInstanceWithTransform(this.blas.getAccelStruct(), 1, 0, 0, Ref(transform[0]));
            frame.buildTopLevelAS(this.topLevelAS);
            this.builtTopLevelAS = true;
        }
    }

    // --- The sample ---------------------------------------------------------------------------

    // Port of the Xbox ATG RaytracingAO_PC12 sample (PCSamples/Raytracing/RaytracingAO_PC12):
    // ambient occlusion by ray tracing beside screen-space ambient occlusion, on a dragon or a maze.
    //
    // AO (AO.cpp, raytracing_ao.hlsl): a primary ray per pixel; at each hit numSamples^2 rays in a
    // hemisphere around the (normal-mapped) normal, from a stratified uniform or cosine sample table
    // made on the CPU with std::mt19937 seeded 0, turned by a per-pixel random tangent frame; the
    // occlusion darkens the material's diffuse color. SSAO (SSAO.cpp, MiniEngine's SSAO): a G-buffer
    // of normals, diffuse color and depth; the depth linearized, downsampled to 1/2 .. 1/16 and
    // deinterleaved into 16-slice atlases (the normals likewise); SSAO at each resolution, from the
    // atlases and from the downsampled buffers; blurred and bilaterally upsampled level by level;
    // then times the diffuse color. Split, SSAO renders the left half and AO the right, each at
    // half the width (the sample's projection then has half the aspect ratio).
    //
    // The output textures are RGBA8_UNORM (the sample's are the back buffer's B8G8R8A8_UNORM) and are
    // copied to the back buffer by blits (the sample copies, or draws a quad when split).
    class RaytracingAoSample {
        private app: App;
        private meshes: Mesh[];
        private placeholderTexture: Opaque;
        private pointWrapSampler: Opaque;
        private linearClampSampler: Opaque;
        private pointClampSampler: Opaque;
        private sceneBuffer: BufferHandle;
        private aoBuffer: BufferHandle;
        private aoOptionsBuffer: BufferHandle;
        private ssaoBuffer: BufferHandle;
        private sceneConstants: f32[];
        private aoRays: f32[];
        private aoOptions: f32[];
        private ssaoConstants: f32[];
        private sampleThickness: number[];
        private aoLayout: Opaque;
        private gbufferLayout: Opaque;
        private prepare1Layout: Opaque;
        private prepare2Layout: Opaque;
        private renderLayout: Opaque;
        private blurBlendOutLayout: Opaque;
        private blurLayout: Opaque;
        private compositeLayout: Opaque;
        private shaderTable: ShaderTable;
        private gbufferVS: Opaque;
        private gbufferPS: Opaque;
        private inputLayout: Opaque;
        private prepare1Pipeline: Opaque;
        private prepare2Pipeline: Opaque;
        private render1Pipeline: Opaque;
        private render2Pipeline: Opaque;
        private blurPreMinBlendOutPipeline: Opaque;
        private blurPreMinPipeline: Opaque;
        private compositePipeline: Opaque;
        private gbufferPipeline: Opaque | null;
        private meshGBufferSets: BindingSet[];

        // Made for the output's size (the frame's, half its width when split).
        private outputWidth: int;
        private outputHeight: int;
        private resources: Opaque[];
        private aoOutput: Opaque | null;
        private ssaoOutput: Opaque | null;
        private gbufferNormals: Opaque | null;
        private gbufferDiffuse: Opaque | null;
        private gbufferDepth: Opaque | null;
        private gbufferFramebuffer: Opaque | null;
        private linearDepth: Opaque | null;
        private depthDownsize: Opaque[];
        private depthTiled: Opaque[];
        private normalDownsize: Opaque[];
        private normalTiled: Opaque[];
        private merged: Opaque[];
        private smooth: Opaque[];
        private highQuality: Opaque[];
        private ssao: Opaque | null;
        private bufferWidth: int[];
        private bufferHeight: int[];
        private frameBindingSets: BindingSet[];
        private meshAoSets: BindingSet[];
        private prepare1Set: BindingSet;
        private prepare2Set: BindingSet;
        private render1Sets: BindingSet[];
        private render2Sets: BindingSet[];
        private blurSets: BindingSet[];
        private compositeSet: BindingSet;

        frameWidth: int;
        frameHeight: int;
        fps: int;
        private fpsFrames: int;
        private fpsTime: number;

        // The sample's state (Sample and Menus).
        meshIndex: int;
        isSplit: boolean;
        radius: number;
        lightingModel: int;
        showFPS: boolean;
        showHelp: boolean;
        selection: int;
        private delta: number;
        private updateOptions: boolean;
        aoDistance: Option;
        aoFalloff: Option;
        aoNumSamples: Option;
        aoSampleType: Option;
        ssaoNoiseFilterTolerance: Option;
        ssaoBlurTolerance: Option;
        ssaoUpsampleTolerance: Option;
        ssaoNormalMultiply: Option;
        options: Option[];
        private aHeld: boolean;
        private dHeld: boolean;

        constructor(app: App) {
            this.app = app;
            this.meshes = [];
            this.sceneConstants = [];
            for (let i = 0; i < SCENE_FLOATS; i++) {
                this.sceneConstants.push(0.0);
            }
            this.aoRays = [];
            for (let i = 0; i < MAX_OCCLUSION_RAYS * 4; i++) {
                this.aoRays.push(0.0);
            }
            this.aoOptions = [0.0, 0.0, 0.0, 0.0];
            this.ssaoConstants = [];
            for (let i = 0; i < SSAO_SLICE_FLOATS * SSAO_SLICES; i++) {
                this.ssaoConstants.push(0.0);
            }
            // SSAO::SSAO: the sample thicknesses.
            this.sampleThickness = [];
            const offsets = [0.2, 0.0, 0.4, 0.0, 0.6, 0.0, 0.8, 0.0, 0.2, 0.2, 0.2, 0.4, 0.2, 0.6, 0.2, 0.8, 0.4, 0.4, 0.4, 0.6,
                0.4, 0.8, 0.6, 0.6];
            for (let i = 0; i < 12; i++) {
                const a = Math.fround(offsets[i * 2]);
                const b = Math.fround(offsets[i * 2 + 1]);
                const value = Math.fround(Math.fround(1.0 - Math.fround(a * a)) - Math.fround(b * b));
                this.sampleThickness.push(Math.fround(Math.sqrt(value)));
            }
            this.gbufferPipeline = null;
            this.meshGBufferSets = [];
            this.outputWidth = 0;
            this.outputHeight = 0;
            this.resources = [];
            this.aoOutput = null;
            this.ssaoOutput = null;
            this.gbufferNormals = null;
            this.gbufferDiffuse = null;
            this.gbufferDepth = null;
            this.gbufferFramebuffer = null;
            this.linearDepth = null;
            this.depthDownsize = [];
            this.depthTiled = [];
            this.normalDownsize = [];
            this.normalTiled = [];
            this.merged = [];
            this.smooth = [];
            this.highQuality = [];
            this.ssao = null;
            this.bufferWidth = [];
            this.bufferHeight = [];
            this.frameBindingSets = [];
            this.meshAoSets = [];
            this.prepare1Set = new BindingSet(null);
            this.prepare2Set = new BindingSet(null);
            this.render1Sets = [];
            this.render2Sets = [];
            this.blurSets = [];
            this.compositeSet = new BindingSet(null);
            this.frameWidth = 1280;
            this.frameHeight = 720;
            this.fps = 0;
            this.fpsFrames = 0;
            this.fpsTime = 0.0;

            this.meshIndex = 0;
            this.isSplit = true;
            this.radius = INITIAL_RADIUS;
            this.lightingModel = LIGHTING_AO;
            this.showFPS = true;
            this.showHelp = false;
            this.selection = 0;
            this.delta = 0.0;
            this.updateOptions = true;
            // Menus.h
            this.aoDistance = new Option(10.0, 0.1, 10000.0, 0.1, false);
            this.aoFalloff = new Option(0.0, -10.0, 10.0, 0.1, false);
            this.aoNumSamples = new Option(12.0, 1.0, 15.0, 1.0, true);
            this.aoSampleType = new Option(0.0, 0.0, 1.0, 1.0, true);
            this.ssaoNoiseFilterTolerance = new Option(-3.0, -8.0, 0.0, 0.1, false);
            this.ssaoBlurTolerance = new Option(-5.0, -8.0, -1.0, 0.1, false);
            this.ssaoUpsampleTolerance = new Option(-7.0, -12.0, -1.0, 0.1, false);
            this.ssaoNormalMultiply = new Option(1.0, 0.0, 5.0, 0.125, false);
            this.options = [this.aoDistance, this.aoFalloff, this.aoNumSamples, this.aoSampleType, this.ssaoNoiseFilterTolerance,
                this.ssaoBlurTolerance, this.ssaoUpsampleTolerance, this.ssaoNormalMultiply];
            this.aHeld = false;
            this.dHeld = false;
        }

        // Sample::Update's keys and Menus::ProcessKeys.
        onKey(key: int, scancode: int, action: int, mods: int): int {
            if (key == KEY_A) {
                this.aHeld = action != ACTION_RELEASE;
            } else if (key == KEY_D) {
                this.dHeld = action != ACTION_RELEASE;
            }
            if (action == ACTION_PRESS) {
                if (key == KEY_SPACE) {
                    this.meshIndex = (this.meshIndex + 1) % MESH_FILES.length;
                } else if (key == KEY_S) {
                    this.isSplit = !this.isSplit;
                } else if (key == KEY_F1) {
                    this.showHelp = !this.showHelp;
                } else if (key == KEY_TAB) {
                    this.lightingModel = (this.lightingModel + 1) % LIGHTING_MODEL_COUNT;
                } else if (key == KEY_F) {
                    this.showFPS = !this.showFPS;
                } else if (this.showHelp) {
                    // The sample's option list has a ninth slot that is null (selecting it and
                    // pressing Left or Right would crash it); it selects nothing here.
                    if (key == KEY_UP) {
                        this.selection = (this.selection + 8) % 9;
                    } else if (key == KEY_DOWN) {
                        this.selection = (this.selection + 1) % 9;
                    } else if (key == KEY_LEFT) {
                        this.delta = -1.0;
                    } else if (key == KEY_RIGHT) {
                        this.delta = 1.0;
                    } else if (key == KEY_R) {
                        for (let i = 0; i < this.options.length; i++) {
                            this.options[i].reset();
                        }
                        this.updateOptions = true;
                    }
                }
            } else if (action == ACTION_RELEASE && (key == KEY_LEFT || key == KEY_RIGHT)) {
                this.delta = 0.0;
            }
            return 1;
        }

        // Sample::Update: the camera radius (A / D held), the menu's held Left / Right.
        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
            const steps = elapsedSeconds * STEPS_PER_SECOND;
            if (this.aHeld) {
                this.radius += CAM_STEP * steps;
            } else if (this.dHeld) {
                this.radius -= CAM_STEP * steps;
            }
            // Held, the selected option steps every frame as in the sample (here at most once per
            // 1/60 s: a step can't be split).
            if (this.showHelp && this.delta != 0.0 && this.selection < this.options.length) {
                const option = this.options[this.selection];
                if (this.delta > 0.0 ? option.increment() : option.decrement()) {
                    this.updateOptions = true;
                }
            }

            // StepTimer::GetFramesPerSecond: frames counted over each second.
            this.fpsFrames++;
            this.fpsTime += elapsedSeconds;
            if (this.fpsTime >= 1.0) {
                this.fps = this.fpsFrames;
                this.fpsFrames = 0;
                this.fpsTime -= Math.floor(this.fpsTime);
            }
        }

        // AO::OnOptionUpdate and SSAO::OnOptionUpdate: the AO options and its sample table
        // (Sampler::SetSeed(0), then a stratified sampler of numSamples x numSamples cells).
        applyOptions(commandList: CommandList): void {
            const numSamples: int = this.aoNumSamples.value();
            const sampleType: int = this.aoSampleType.value();
            this.aoOptions[0] = this.aoDistance.value();
            this.aoOptions[1] = this.aoFalloff.value();
            Donut_StoreInt32(Ref(this.aoOptions[2]), numSamples);
            Donut_StoreInt32(Ref(this.aoOptions[3]), sampleType);
            commandList.writeBuffer(this.aoOptionsBuffer, Ref(this.aoOptions[0]), 16);

            // std::uniform_real_distribution<float>(0, nextafter(1.f)) over std::mt19937(0).
            const engine = this.app.createRandomEngine(0);
            const upper = 1.00000011920928955;
            const offset = Math.fround(1.0 / numSamples);
            const twoPi = Math.fround(6.283185307);
            for (let i = 0; i < MAX_OCCLUSION_RAYS * 4; i++) {
                this.aoRays[i] = 0.0;
            }
            for (let i = 0; i < numSamples; i++) {
                for (let j = 0; j < numSamples; j++) {
                    const u = Math.fround(Math.fround(i * offset) + Math.fround(Donut_RandomUniformFloat(engine, 0.0, upper) * offset));
                    const v = Math.fround(Math.fround(j * offset) + Math.fround(Donut_RandomUniformFloat(engine, 0.0, upper) * offset));
                    let x = 0.0;
                    let y = 0.0;
                    let z = 0.0;
                    const phi = Math.fround(v * twoPi);
                    if (sampleType == 0) {
                        // UniformHemiSampler
                        const sintheta = Math.fround(Math.sqrt(u));
                        const cosTheta = Math.fround(Math.sqrt(Math.fround(1.0 - Math.fround(sintheta * sintheta))));
                        x = Math.fround(sintheta * Math.fround(Math.cos(phi)));
                        y = Math.fround(sintheta * Math.fround(Math.sin(phi)));
                        z = cosTheta;
                    } else {
                        // CosineHemiSampler
                        const sintheta = Math.fround(Math.acos(Math.fround(Math.sqrt(u))));
                        x = Math.fround(sintheta * Math.fround(Math.cos(phi)));
                        y = Math.fround(sintheta * Math.fround(Math.sin(phi)));
                        z = Math.fround(Math.sqrt(Math.fround(Math.fround(1.0 - Math.fround(x * x)) - Math.fround(y * y))));
                    }
                    const index = (i * numSamples + j) * 4;
                    this.aoRays[index] = x;
                    this.aoRays[index + 1] = y;
                    this.aoRays[index + 2] = z;
                }
            }
            this.app.releaseObject(engine);
            commandList.writeBuffer(this.aoBuffer, Ref(this.aoRays[0]), MAX_OCCLUSION_RAYS * 16);
        }

        // The outputs' share of the frame's width: half when split.
        widthScale(): number {
            const scale: number = this.isSplit ? 0.5 : 1.0;
            return scale;
        }

        // Sample::UpdateCameraMatrices: the camera on the z axis looking at the origin, the
        // frustum's far corners for SSAO's position reconstruction.
        updateScene(width: int, height: int): number[] {
            const screenWidth = Math.fround(width * this.widthScale());
            const screenHeight = height;
            const eye = [0.0, 0.0, this.radius];
            const view = lookAtLH(eye, [0.0, 0.0, 0.0], [0.0, 1.0, 0.0]);
            const aspectRatio = Math.fround(screenWidth / screenHeight);
            const proj = perspectiveFovLH(Math.fround(45.0 * (Math.PI / 180.0)), aspectRatio, NEAR_PLANE, FAR_PLANE);
            const viewProj = multiply(view, proj);
            const c = this.sceneConstants;
            const worldView = transpose(view);
            const worldViewProjection = transpose(viewProj);
            const projectionToWorld = transpose(inverse(viewProj));
            for (let i = 0; i < 16; i++) {
                c[i] = worldView[i];
                c[16 + i] = worldViewProjection[i];
                c[32 + i] = projectionToWorld[i];
            }
            c[SCENE_CAMERA] = eye[0];
            c[SCENE_CAMERA + 1] = eye[1];
            c[SCENE_CAMERA + 2] = eye[2];
            c[SCENE_CAMERA + 3] = 1.0;

            // BoundingFrustum::CreateFromMatrix(proj): the slopes and far plane from the inverse
            // projection, then GetCorners' 4 (left top far), 6 (right bottom far) and 7 (left
            // bottom far), into world space.
            const invProj = inverse(proj);
            const right = transform4([1.0, 0.0, 1.0, 1.0], invProj);
            const left = transform4([-1.0, 0.0, 1.0, 1.0], invProj);
            const top = transform4([0.0, 1.0, 1.0, 1.0], invProj);
            const bottom = transform4([0.0, -1.0, 1.0, 1.0], invProj);
            const far = transform4([0.0, 0.0, 1.0, 1.0], invProj);
            const rightSlope = Math.fround(right[0] / right[2]);
            const leftSlope = Math.fround(left[0] / left[2]);
            const topSlope = Math.fround(top[1] / top[2]);
            const bottomSlope = Math.fround(bottom[1] / bottom[2]);
            const farZ = Math.fround(far[2] / far[3]);
            const viewToWorld = inverse(view);
            const lowerLeft = transform4([Math.fround(leftSlope * farZ), Math.fround(bottomSlope * farZ), farZ, 1.0], viewToWorld);
            const lowerRight = transform4([Math.fround(rightSlope * farZ), Math.fround(bottomSlope * farZ), farZ, 1.0], viewToWorld);
            const topLeft = transform4([Math.fround(leftSlope * farZ), Math.fround(topSlope * farZ), farZ, 1.0], viewToWorld);
            for (let i = 0; i < 3; i++) {
                c[SCENE_CAMERA + 4 + i] = Math.fround(topLeft[i] - eye[i]);
                c[SCENE_CAMERA + 8 + i] = Math.fround(lowerRight[i] - lowerLeft[i]);
                c[SCENE_CAMERA + 12 + i] = Math.fround(lowerLeft[i] - topLeft[i]);
            }
            // Update's noise tile (unused by the shaders): its height halved too when split.
            c[SCENE_CAMERA + 16] = Math.fround(screenWidth / NOISE_W);
            c[SCENE_CAMERA + 17] = Math.fround(Math.fround(height * this.widthScale()) / NOISE_W);
            return proj;
        }

        // SSAO::UpdateSSAOConstant into a slice of the SSAO constants.
        updateSsaoRenderConstants(slice: int, width: int, height: int, depth: int, tanHalfFovH: number): void {
            const base = slice * SSAO_SLICE_FLOATS;
            const c = this.ssaoConstants;
            // The shaders are set up to sample a circular region within a 5-pixel radius.
            const screenspaceDiameter = 10.0;
            let thicknessMultiplier = Math.fround(Math.fround(Math.fround(2.0 * tanHalfFovH) * screenspaceDiameter) / width);
            if (depth == 1) {
                thicknessMultiplier = Math.fround(thicknessMultiplier * 2.0);
            }
            // This will transform a depth value from [0, thickness] to [0, 1].
            const inverseRangeFactor = Math.fround(1.0 / thicknessMultiplier);
            for (let i = 0; i < 12; i++) {
                c[base + i] = Math.fround(inverseRangeFactor / this.sampleThickness[i]);
            }
            const t = this.sampleThickness;
            let weights = [
                Math.fround(4.0 * t[0]), Math.fround(4.0 * t[1]), Math.fround(4.0 * t[2]), Math.fround(4.0 * t[3]),
                Math.fround(4.0 * t[4]), Math.fround(8.0 * t[5]), Math.fround(8.0 * t[6]), Math.fround(8.0 * t[7]),
                Math.fround(4.0 * t[8]), Math.fround(8.0 * t[9]), Math.fround(8.0 * t[10]), Math.fround(4.0 * t[11]),
            ];
            // Not SAMPLE_EXHAUSTIVELY: every other cell.
            weights[0] = 0.0;
            weights[2] = 0.0;
            weights[5] = 0.0;
            weights[7] = 0.0;
            weights[9] = 0.0;
            let netWeight = 0.0;
            for (let i = 0; i < 12; i++) {
                netWeight = Math.fround(netWeight + weights[i]);
            }
            for (let i = 0; i < 12; i++) {
                c[base + 12 + i] = Math.fround(weights[i] / netWeight);
            }
            c[base + 24] = Math.fround(1.0 / width);
            c[base + 25] = Math.fround(1.0 / height);
            const normalToDepthBrightnessEqualize = 2.0;
            c[base + 26] = Math.fround(normalToDepthBrightnessEqualize * Math.fround(this.ssaoNormalMultiply.value()));
        }

        // SSAO::UpdateBlurAndUpsampleConstant into a slice of the SSAO constants.
        updateBlurConstants(slice: int, lowWidth: int, lowHeight: int, highWidth: int, highHeight: int): void {
            const base = slice * SSAO_SLICE_FLOATS;
            const c = this.ssaoConstants;
            const screenWidth = this.outputWidth;
            let blurTolerance = Math.fround(1.0 - Math.fround(Math.fround(Math.pow(10.0, Math.fround(this.ssaoBlurTolerance.value())))
                * screenWidth) / lowWidth);
            blurTolerance = Math.fround(blurTolerance * blurTolerance);
            const upsampleTolerance = Math.fround(Math.pow(10.0, Math.fround(this.ssaoUpsampleTolerance.value())));
            const noiseFilterWeight = Math.fround(1.0 / Math.fround(Math.fround(Math.pow(10.0,
                Math.fround(this.ssaoNoiseFilterTolerance.value()))) + upsampleTolerance));
            c[base] = Math.fround(1.0 / lowWidth);
            c[base + 1] = Math.fround(1.0 / lowHeight);
            c[base + 2] = Math.fround(1.0 / highWidth);
            c[base + 3] = Math.fround(1.0 / highHeight);
            c[base + 4] = noiseFilterWeight;
            c[base + 5] = Math.fround(screenWidth / lowWidth);
            c[base + 6] = blurTolerance;
            c[base + 7] = upsampleTolerance;
        }

        releaseFrameResources(): void {
            for (let i = 0; i < this.frameBindingSets.length; i++) {
                this.app.releaseResource(this.frameBindingSets[i].handle);
            }
            this.frameBindingSets = [];
            for (let i = 0; i < this.resources.length; i++) {
                this.app.releaseResource(this.resources[i]);
            }
            this.resources = [];
            this.meshAoSets = [];
            this.render1Sets = [];
            this.render2Sets = [];
            this.blurSets = [];
            this.depthDownsize = [];
            this.depthTiled = [];
            this.normalDownsize = [];
            this.normalTiled = [];
            this.merged = [];
            this.smooth = [];
            this.highQuality = [];
            this.aoOutput = null;
            this.ssaoOutput = null;
            this.gbufferNormals = null;
            this.gbufferDiffuse = null;
            this.gbufferDepth = null;
            this.gbufferFramebuffer = null;
            this.linearDepth = null;
            this.ssao = null;
            this.outputWidth = 0;
            this.outputHeight = 0;
            // The blits cached binding sets of the outputs.
            this.app.clearBindingCache();
        }

        onBackBufferResizing(): void {
            this.releaseFrameResources();
        }

        own(resource: Opaque): Opaque {
            this.resources.push(resource);
            return resource;
        }

        frameSet(desc: BindingSetDesc, layout: Opaque): BindingSet {
            const set = this.app.createBindingSetForLayout(desc, layout);
            this.frameBindingSets.push(set);
            return set;
        }

        // AO::CreateRaytracingOutputResource and SSAO::CreateResources / BindResources for an output
        // of width x height, and each pass's bindings.
        createFrameResources(width: int, height: int): void {
            this.outputWidth = width;
            this.outputHeight = height;
            this.aoOutput = this.own(this.app.createUAVTextureWithFormat(width, height, Format.RGBA8_UNORM, "RaytracingOutput"));
            this.ssaoOutput = this.own(this.app.createUAVTextureWithFormat(width, height, Format.RGBA8_UNORM, "OutFrame"));

            // The G-buffer: normals and diffuse color (the sample's two R11G11B10 slices), depth.
            this.gbufferNormals = this.own(this.app.createRenderTargetTexture(width, height, Format.R11G11B10_FLOAT, "GBufferNormals"));
            this.gbufferDiffuse = this.own(this.app.createRenderTargetTexture(width, height, Format.R11G11B10_FLOAT, "GBufferDiffuse"));
            this.gbufferDepth = this.own(this.app.createDepthTexture(width, height, Format.D32, 1.0, "GBufferDepth"));
            this.gbufferFramebuffer = this.own(this.app.createFramebufferWithTwoTargets(this.gbufferNormals as Opaque,
                this.gbufferDiffuse as Opaque, this.gbufferDepth));

            // Buffer sizes: 1/2, 1/4 ... 1/64, rounded up.
            this.bufferWidth = [];
            this.bufferHeight = [];
            for (let i = 0; i < NUM_BUFFERS + 2; i++) {
                const power = 1 << (i + 1);
                this.bufferWidth.push(Math.floor((width + power - 1) / power));
                this.bufferHeight.push(Math.floor((height + power - 1) / power));
            }
            this.linearDepth = this.own(this.app.createUAVTextureWithFormat(width, height, Format.R16_FLOAT, "LinearDepth"));
            for (let i = 0; i < NUM_BUFFERS; i++) {
                const w = this.bufferWidth[i];
                const h = this.bufferHeight[i];
                const tiledW = this.bufferWidth[i + 2];
                const tiledH = this.bufferHeight[i + 2];
                this.depthDownsize.push(this.own(this.app.createUAVTextureWithFormat(w, h, Format.R32_FLOAT, "DepthDownsize")));
                this.depthTiled.push(this.own(this.app.createUAVTextureArray(tiledW, tiledH, 16, Format.R16_FLOAT, "DepthTiled")));
                this.normalDownsize.push(this.own(this.app.createUAVTextureWithFormat(w, h, Format.R10G10B10A2_UNORM, "NormalDownsize")));
                this.normalTiled.push(this.own(this.app.createUAVTextureArray(tiledW, tiledH, 16, Format.R10G10B10A2_UNORM, "NormalTiled")));
                this.merged.push(this.own(this.app.createUAVTextureWithFormat(w, h, Format.R8_UNORM, "Merged")));
                if (i < NUM_BUFFERS - 1) {
                    this.smooth.push(this.own(this.app.createUAVTextureWithFormat(w, h, Format.R8_UNORM, "Smooth")));
                }
                this.highQuality.push(this.own(this.app.createUAVTextureWithFormat(w, h, Format.R8_UNORM, "HighQuality")));
            }
            this.ssao = this.own(this.app.createUAVTextureWithFormat(width, height, Format.R8_UNORM, "SSAO"));
            const linearDepth = this.linearDepth as Opaque;
            const gbufferDepth = this.gbufferDepth as Opaque;

            // AO: per mesh (its geometry and material are global bindings here).
            for (let m = 0; m < this.meshes.length; m++) {
                const mesh = this.meshes[m];
                const desc = BindingSetDesc.create();
                desc.bindTextureUAV(0, this.aoOutput as Opaque);
                desc.bindAccelStruct(0, mesh.topLevelAS.getTopLevelAS());
                desc.bindEntireConstantBuffer(0, this.sceneBuffer);
                desc.bindEntireConstantBuffer(1, this.aoBuffer);
                desc.bindEntireConstantBuffer(2, this.aoOptionsBuffer);
                desc.bindSampler(0, this.pointWrapSampler);
                desc.bindSampler(1, this.linearClampSampler);
                desc.bindEntireConstantBuffer(3, mesh.materialBuffer);
                desc.bindRawBufferSRV(1, mesh.indexBuffer);
                desc.bindRawBufferSRV(2, mesh.vertexBuffer);
                desc.bindTextureSRV(3, mesh.diffuseTexture);
                desc.bindTextureSRV(4, mesh.specularTexture);
                desc.bindTextureSRV(5, mesh.normalTexture);
                this.meshAoSets.push(this.frameSet(desc, this.aoLayout));
            }

            // Phase 2: decompress, linearize, downsample and deinterleave the depth buffer.
            const prepare1 = BindingSetDesc.create();
            prepare1.bindTextureSRV(0, gbufferDepth);
            prepare1.bindTextureSRV(1, this.gbufferNormals as Opaque);
            prepare1.bindTextureUAV(0, linearDepth);
            prepare1.bindTextureUAV(1, this.depthDownsize[0]);
            prepare1.bindTextureUAV(2, this.depthTiled[0]);
            prepare1.bindTextureUAV(3, this.depthDownsize[1]);
            prepare1.bindTextureUAV(4, this.depthTiled[1]);
            prepare1.bindTextureUAV(5, this.normalDownsize[0]);
            prepare1.bindTextureUAV(6, this.normalTiled[0]);
            prepare1.bindTextureUAV(7, this.normalDownsize[1]);
            prepare1.bindTextureUAV(8, this.normalTiled[1]);
            this.prepare1Set = this.frameSet(prepare1, this.prepare1Layout);

            const prepare2 = BindingSetDesc.create();
            prepare2.bindTextureSRV(0, this.depthDownsize[1]);
            prepare2.bindTextureSRV(1, this.normalDownsize[1]);
            prepare2.bindTextureUAV(0, this.depthDownsize[2]);
            prepare2.bindTextureUAV(1, this.depthTiled[2]);
            prepare2.bindTextureUAV(2, this.depthDownsize[3]);
            prepare2.bindTextureUAV(3, this.depthTiled[3]);
            prepare2.bindTextureUAV(4, this.normalDownsize[2]);
            prepare2.bindTextureUAV(5, this.normalTiled[2]);
            prepare2.bindTextureUAV(6, this.normalDownsize[3]);
            prepare2.bindTextureUAV(7, this.normalTiled[3]);
            this.prepare2Set = this.frameSet(prepare2, this.prepare2Layout);

            // Phase 3: SSAO for each atlas (into the merged buffers) and each downsized buffer
            // (into the high quality ones).
            for (let i = 0; i < NUM_BUFFERS; i++) {
                const tiled = BindingSetDesc.create();
                tiled.bindEntireConstantBuffer(0, this.sceneBuffer);
                tiled.bindConstantBuffer(1, this.ssaoBuffer, (SSAO_TILED_SLICE + i) * SSAO_SLICE_FLOATS * 4, SSAO_SLICE_FLOATS * 4);
                tiled.bindTextureSRV(0, this.depthTiled[i]);
                tiled.bindTextureSRV(1, this.normalTiled[i]);
                tiled.bindTextureUAV(0, this.merged[i]);
                tiled.bindSampler(3, this.pointClampSampler);
                this.render1Sets.push(this.frameSet(tiled, this.renderLayout));

                const downsized = BindingSetDesc.create();
                downsized.bindEntireConstantBuffer(0, this.sceneBuffer);
                downsized.bindConstantBuffer(1, this.ssaoBuffer, (SSAO_HIGH_QUALITY_SLICE + i) * SSAO_SLICE_FLOATS * 4,
                    SSAO_SLICE_FLOATS * 4);
                downsized.bindTextureSRV(0, this.depthDownsize[i]);
                downsized.bindTextureSRV(1, this.normalDownsize[i]);
                downsized.bindTextureUAV(0, this.highQuality[i]);
                downsized.bindSampler(3, this.pointClampSampler);
                this.render2Sets.push(this.frameSet(downsized, this.renderLayout));
            }

            // Phase 4: blur and upsample, from the lowest resolution up (blurSets[i] for level i).
            for (let i = 0; i < NUM_BUFFERS; i++) {
                const blur = BindingSetDesc.create();
                blur.bindConstantBuffer(1, this.ssaoBuffer, (SSAO_BLUR_SLICE + i) * SSAO_SLICE_FLOATS * 4, SSAO_SLICE_FLOATS * 4);
                blur.bindSampler(0, this.linearClampSampler);
                blur.bindTextureSRV(0, this.depthDownsize[i]);
                blur.bindTextureSRV(3, this.highQuality[i]);
                if (i == 0) {
                    blur.bindTextureSRV(1, linearDepth);
                    blur.bindTextureSRV(2, this.smooth[0]);
                    blur.bindTextureUAV(0, this.ssao as Opaque);
                    this.blurSets.push(this.frameSet(blur, this.blurLayout));
                } else {
                    blur.bindTextureSRV(1, this.depthDownsize[i - 1]);
                    blur.bindTextureSRV(2, i == NUM_BUFFERS - 1 ? this.merged[i] : this.smooth[i]);
                    blur.bindTextureSRV(4, this.merged[i - 1]);
                    blur.bindTextureUAV(0, this.smooth[i - 1]);
                    this.blurSets.push(this.frameSet(blur, this.blurBlendOutLayout));
                }
            }

            // Phase 5: the SSAO times the diffuse color.
            const composite = BindingSetDesc.create();
            composite.bindTextureSRV(0, this.ssao as Opaque);
            composite.bindTextureSRV(1, this.gbufferDiffuse as Opaque);
            composite.bindTextureSRV(2, gbufferDepth);
            composite.bindTextureUAV(0, this.ssaoOutput as Opaque);
            this.compositeSet = this.frameSet(composite, this.compositeLayout);
        }

        // SSAO::OnCameraChanged and UpdateConstants: the dispatches' constants for this output.
        updateSsaoConstants(proj: number[]): void {
            // The first element of the projection: the cotangent of half the horizontal FOV.
            const fovTangent = Math.fround(1.0 / proj[0]);
            for (let i = 0; i < NUM_BUFFERS; i++) {
                this.updateSsaoRenderConstants(SSAO_TILED_SLICE + i, this.bufferWidth[i + 2], this.bufferHeight[i + 2], 16, fovTangent);
                this.updateSsaoRenderConstants(SSAO_HIGH_QUALITY_SLICE + i, this.bufferWidth[i], this.bufferHeight[i], 1, fovTangent);
                const highWidth = i == 0 ? this.outputWidth : this.bufferWidth[i - 1];
                const highHeight = i == 0 ? this.outputHeight : this.bufferHeight[i - 1];
                this.updateBlurConstants(SSAO_BLUR_SLICE + i, this.bufferWidth[i], this.bufferHeight[i], highWidth, highHeight);
            }
        }

        // AO::RunAORaytracing: the primary and AO rays into the AO output.
        runAo(frame: Frame): void {
            frame.dispatchRays(this.shaderTable, this.meshAoSets[this.meshIndex], this.outputWidth, this.outputHeight);
        }

        // SSAO::Run: the G-buffer, then the SSAO dispatches, into the SSAO output.
        runSsao(frame: Frame, commandList: CommandList): void {
            const mesh = this.meshes[this.meshIndex];

            // Phase 1: Render GBuffer.
            commandList.clearDepth(this.gbufferDepth as Opaque, 1.0);
            frame.beginDrawToFramebuffer(this.gbufferPipeline as Opaque, this.gbufferFramebuffer as Opaque);
            frame.drawAddBindingSet(this.meshGBufferSets[this.meshIndex]);
            frame.drawAddVertexBuffer(mesh.vertexBuffer, 0, 0);
            frame.drawSetIndexBuffer(mesh.indexBuffer);
            frame.drawIndexed(mesh.indexCount);

            // Phase 2: Decompress, linearize, downsample, and deinterleave the depth buffer.
            commandList.dispatch(this.prepare1Pipeline, this.prepare1Set, numGroups(this.bufferWidth[3] * 8, 8), numGroups(this.bufferHeight[3] * 8, 8), 1);
            commandList.dispatch(this.prepare2Pipeline, this.prepare2Set, numGroups(this.bufferWidth[5] * 8, 8), numGroups(this.bufferHeight[5] * 8, 8), 1);

            // Phase 3: Render SSAO for each sub-tile.
            for (let i = 0; i < NUM_BUFFERS; i++) {
                commandList.dispatch(this.render1Pipeline, this.render1Sets[i], numGroups(this.bufferWidth[i + 2], 8),
                    numGroups(this.bufferHeight[i + 2], 8), 16);
            }
            for (let i = 0; i < NUM_BUFFERS; i++) {
                commandList.dispatch(this.render2Pipeline, this.render2Sets[i], numGroups(this.bufferWidth[i], 16), numGroups(this.bufferHeight[i], 16), 1);
            }

            // Phase 4: Iteratively blur and upsample, combining each result.
            for (let i = NUM_BUFFERS - 1; i >= 0; i--) {
                const highWidth = i == 0 ? this.outputWidth : this.bufferWidth[i - 1];
                const highHeight = i == 0 ? this.outputHeight : this.bufferHeight[i - 1];
                commandList.dispatch(i == 0 ? this.blurPreMinPipeline : this.blurPreMinBlendOutPipeline, this.blurSets[i],
                    numGroups(highWidth + 2, 16), numGroups(highHeight + 2, 16), 1);
            }

            // Phase 5: Render.
            commandList.dispatch(this.compositePipeline, this.compositeSet, numGroups(this.bufferWidth[1] * 8, 8), numGroups(this.bufferHeight[1] * 8, 8), 1);
        }

        // Sample::Render (the HUD is the ImGui pass's).
        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();
            this.frameWidth = width;
            this.frameHeight = height;

            // Lighting::ChangeScreenScale: the outputs at half the width when split.
            const outputWidth: int = Math.floor(width * this.widthScale());
            if (outputWidth != this.outputWidth || height != this.outputHeight) {
                this.releaseFrameResources();
                this.createFrameResources(outputWidth, height);
            }
            if (!this.gbufferPipeline) {
                const desc = GraphicsPipelineDesc.create(this.gbufferVS, this.gbufferPS);
                desc.addBindingLayout(this.gbufferLayout);
                desc.setInputLayout(this.inputLayout);
                desc.setDepthState(1, 1, ComparisonFunc.Less);
                desc.setRasterState(CullMode.Back, FillMode.Solid, 0);
                this.gbufferPipeline = this.app.createGraphicsPipelineFromDesc(desc, this.gbufferFramebuffer as Opaque);
            }
            for (let m = 0; m < this.meshes.length; m++) {
                this.meshes[m].buildTopLevelAS(frame);
            }

            if (this.updateOptions) {
                this.applyOptions(commandList);
                this.updateOptions = false;
            }
            const proj = this.updateScene(width, height);
            this.updateSsaoConstants(proj);
            commandList.writeBuffer(this.sceneBuffer, Ref(this.sceneConstants[0]), SCENE_FLOATS * 4);
            commandList.writeBuffer(this.ssaoBuffer, Ref(this.ssaoConstants[0]), SSAO_SLICE_FLOATS * SSAO_SLICES * 4);

            // Apply lighting model: split, SSAO left and AO right.
            const runAo = this.isSplit || this.lightingModel == LIGHTING_AO;
            const runSsao = this.isSplit || this.lightingModel == LIGHTING_SSAO;
            if (runAo) {
                this.runAo(frame);
            }
            if (runSsao) {
                this.runSsao(frame, commandList);
            }
            if (this.isSplit) {
                Donut_BlitTextureSlice(this.app.handle, frame.handle, this.ssaoOutput as Opaque, 0, 0.0, 0.0, outputWidth, height);
                Donut_BlitTextureSlice(this.app.handle, frame.handle, this.aoOutput as Opaque, 0, width - outputWidth, 0.0, outputWidth, height);
            } else {
                Donut_BlitTexture(this.app.handle, frame.handle, (runAo ? this.aoOutput : this.ssaoOutput) as Opaque);
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        // Sample::CreateDeviceDependentResources, AO::Setup, SSAO::Setup.
        init(): boolean {
            // CommonRenderPasses (behind the common samplers and the blits) opens its own command
            // list: before ours.
            this.linearClampSampler = this.app.getCommonSampler(CommonSampler.LinearClamp);
            this.pointClampSampler = this.app.getCommonSampler(CommonSampler.PointClamp);
            this.pointWrapSampler = this.app.createSamplerWithDesc(0, 0, 0, SamplerAddressMode.Wrap, 0.0, 0.0, 1000.0, 1.0);

            // AO's global root signature, with its local one's mesh arguments.
            const aoLayoutDesc = BindingLayoutDesc.create();
            aoLayoutDesc.layoutTextureUAV(0);
            aoLayoutDesc.layoutAccelStruct(0);
            aoLayoutDesc.layoutConstantBuffer(0);
            aoLayoutDesc.layoutConstantBuffer(1);
            aoLayoutDesc.layoutConstantBuffer(2);
            aoLayoutDesc.layoutSampler(0);
            aoLayoutDesc.layoutSampler(1);
            aoLayoutDesc.layoutConstantBuffer(3);
            aoLayoutDesc.layoutRawBufferSRV(1);
            aoLayoutDesc.layoutRawBufferSRV(2);
            aoLayoutDesc.layoutTextureSRV(3);
            aoLayoutDesc.layoutTextureSRV(4);
            aoLayoutDesc.layoutTextureSRV(5);
            this.aoLayout = this.app.createBindingLayout(aoLayoutDesc, ShaderType.All);

            // AO::CreateRaytracingPipelineStateObject: payload of a float4, recursion depth 2.
            const library = this.app.createShaderLibrary("raytracing_ao.hlsl");
            if (!library) {
                return false;
            }
            const pipelineDesc = RtPipelineDesc.create(16, 2);
            pipelineDesc.addGlobalBindingLayout(this.aoLayout);
            pipelineDesc.addShader(library, "AORaygenShader", ShaderType.RayGeneration);
            pipelineDesc.addShader(library, "AOMissShader", ShaderType.Miss);
            pipelineDesc.addShader(library, "AOBounceMissShader", ShaderType.Miss);
            pipelineDesc.addHitGroup(library, "AOHitGroup", "AOClosestHitShader", "", null);
            pipelineDesc.addHitGroup(library, "AOBounceHitGroup", "AOBounceClosestHitShader", "", null);
            const pipeline = this.app.createRayTracingPipelineFromDesc(pipelineDesc);
            if (!pipeline) {
                return false;
            }
            // AO::BuildShaderTables: the primary and bounce entries (GeometryStride 2) of the one part.
            const shaderTable = this.app.createEmptyShaderTable(pipeline);
            this.app.releaseResource(pipeline);
            shaderTable.setRayGeneration("AORaygenShader");
            shaderTable.addMiss("AOMissShader");
            shaderTable.addMiss("AOBounceMissShader");
            shaderTable.addHitGroup("AOHitGroup", null);
            shaderTable.addHitGroup("AOBounceHitGroup", null);
            this.shaderTable = shaderTable;

            // SSAO's root signature, as each pass uses it.
            const gbufferLayoutDesc = BindingLayoutDesc.create();
            gbufferLayoutDesc.layoutConstantBuffer(0);
            gbufferLayoutDesc.layoutConstantBuffer(2);
            gbufferLayoutDesc.layoutTextureSRV(0);
            gbufferLayoutDesc.layoutTextureSRV(1);
            gbufferLayoutDesc.layoutTextureSRV(2);
            gbufferLayoutDesc.layoutSampler(2);
            this.gbufferLayout = this.app.createBindingLayout(gbufferLayoutDesc, ShaderType.All);
            const prepare1LayoutDesc = BindingLayoutDesc.create();
            prepare1LayoutDesc.layoutTextureSRV(0);
            prepare1LayoutDesc.layoutTextureSRV(1);
            for (let i = 0; i < 9; i++) {
                prepare1LayoutDesc.layoutTextureUAV(i);
            }
            this.prepare1Layout = this.app.createBindingLayout(prepare1LayoutDesc, ShaderType.Compute);
            const prepare2LayoutDesc = BindingLayoutDesc.create();
            prepare2LayoutDesc.layoutTextureSRV(0);
            prepare2LayoutDesc.layoutTextureSRV(1);
            for (let i = 0; i < 8; i++) {
                prepare2LayoutDesc.layoutTextureUAV(i);
            }
            this.prepare2Layout = this.app.createBindingLayout(prepare2LayoutDesc, ShaderType.Compute);
            const renderLayoutDesc = BindingLayoutDesc.create();
            renderLayoutDesc.layoutConstantBuffer(0);
            renderLayoutDesc.layoutConstantBuffer(1);
            renderLayoutDesc.layoutTextureSRV(0);
            renderLayoutDesc.layoutTextureSRV(1);
            renderLayoutDesc.layoutTextureUAV(0);
            renderLayoutDesc.layoutSampler(3);
            this.renderLayout = this.app.createBindingLayout(renderLayoutDesc, ShaderType.Compute);
            for (let b = 0; b < 2; b++) {
                const blurLayoutDesc = BindingLayoutDesc.create();
                blurLayoutDesc.layoutConstantBuffer(1);
                blurLayoutDesc.layoutSampler(0);
                for (let i = 0; i < (b == 0 ? 5 : 4); i++) {
                    blurLayoutDesc.layoutTextureSRV(i);
                }
                blurLayoutDesc.layoutTextureUAV(0);
                const layout = this.app.createBindingLayout(blurLayoutDesc, ShaderType.Compute);
                if (b == 0) {
                    this.blurBlendOutLayout = layout;
                } else {
                    this.blurLayout = layout;
                }
            }
            const compositeLayoutDesc = BindingLayoutDesc.create();
            compositeLayoutDesc.layoutTextureSRV(0);
            compositeLayoutDesc.layoutTextureSRV(1);
            compositeLayoutDesc.layoutTextureSRV(2);
            compositeLayoutDesc.layoutTextureUAV(0);
            this.compositeLayout = this.app.createBindingLayout(compositeLayoutDesc, ShaderType.Compute);

            // SSAO::SetupPipelines.
            this.gbufferVS = this.app.createShader("raytracing_ao_gbuffer.hlsl", "gbuffer_vs", ShaderType.Vertex);
            this.gbufferPS = this.app.createShader("raytracing_ao_gbuffer.hlsl", "gbuffer_ps", ShaderType.Pixel);
            const prepare1CS = this.app.createShader("raytracing_ao_ssao_prepare1.hlsl", "main", ShaderType.Compute);
            const prepare2CS = this.app.createShader("raytracing_ao_ssao_prepare2.hlsl", "main", ShaderType.Compute);
            const render1CS = this.app.createShaderWithDefine("raytracing_ao_ssao_render.hlsl", "main", ShaderType.Compute,
                "INTERLEAVE_RESULT", "1");
            const render2CS = this.app.createShaderWithDefine("raytracing_ao_ssao_render.hlsl", "main", ShaderType.Compute,
                "INTERLEAVE_RESULT", "0");
            const blurBlendOutCS = this.app.createShaderWithDefine("raytracing_ao_ssao_blur.hlsl", "main", ShaderType.Compute,
                "BLEND_WITH_HIGHER_RESOLUTION", "1");
            const blurCS = this.app.createShaderWithDefine("raytracing_ao_ssao_blur.hlsl", "main", ShaderType.Compute,
                "BLEND_WITH_HIGHER_RESOLUTION", "0");
            const compositeCS = this.app.createShader("raytracing_ao_ssao_composite.hlsl", "main", ShaderType.Compute);
            if (!this.gbufferVS || !this.gbufferPS || !prepare1CS || !prepare2CS || !render1CS || !render2CS || !blurBlendOutCS
                || !blurCS || !compositeCS) {
                return false;
            }
            this.prepare1Pipeline = this.app.createComputePipelineWithLayout(prepare1CS, this.prepare1Layout);
            this.prepare2Pipeline = this.app.createComputePipelineWithLayout(prepare2CS, this.prepare2Layout);
            this.render1Pipeline = this.app.createComputePipelineWithLayout(render1CS, this.renderLayout);
            this.render2Pipeline = this.app.createComputePipelineWithLayout(render2CS, this.renderLayout);
            this.blurPreMinBlendOutPipeline = this.app.createComputePipelineWithLayout(blurBlendOutCS, this.blurBlendOutLayout);
            this.blurPreMinPipeline = this.app.createComputePipelineWithLayout(blurCS, this.blurLayout);
            this.compositePipeline = this.app.createComputePipelineWithLayout(compositeCS, this.compositeLayout);

            // The vertices for the G-buffer pass.
            const inputLayoutDesc = InputLayoutDesc.create();
            inputLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_STRIDE);
            inputLayoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, 12, 0, VERTEX_STRIDE);
            inputLayoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 24, 0, VERTEX_STRIDE);
            inputLayoutDesc.addVertexAttribute("TANGENT", Format.RGB32_FLOAT, 32, 0, VERTEX_STRIDE);
            this.inputLayout = this.app.createInputLayout(inputLayoutDesc, this.gbufferVS);

            this.sceneBuffer = this.app.createConstantBuffer(512, "SceneConstantBuffer");
            this.aoBuffer = this.app.createConstantBuffer(MAX_OCCLUSION_RAYS * 16, "AOConstantBuffer");
            this.aoOptionsBuffer = this.app.createConstantBuffer(256, "AOOptionsConstantBuffer");
            this.ssaoBuffer = this.app.createConstantBuffer(SSAO_SLICE_FLOATS * SSAO_SLICES * 4, "SSAOConstants");

            // Both meshes up front (the sample loads one at a time, Space reloading); a white
            // texture where a material has none (the sample leaves those descriptors unwritten).
            const commandList = this.app.createCommandList();
            commandList.open();
            this.placeholderTexture = this.app.createTextureWithLevels(1, 1, 1, Format.RGBA8_UNORM, "Placeholder");
            let white: int[] = [-1];
            commandList.writeTextureLevel(this.placeholderTexture, 0, Ref(white[0]), 4);
            let loaded = true;
            for (let i = 0; i < MESH_FILES.length; i++) {
                const mesh = new Mesh();
                if (!mesh.load(this.app, commandList, MESH_FILES[i], this.placeholderTexture)) {
                    loaded = false;
                }
                this.meshes.push(mesh);
            }
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!loaded) {
                console.log("Cannot load the sample's meshes: set XBOX_ATG_SAMPLES_DIR when configuring");
                return false;
            }

            // SSAO::SetMesh: each mesh's G-buffer pass bindings.
            for (let m = 0; m < this.meshes.length; m++) {
                const mesh = this.meshes[m];
                const desc = BindingSetDesc.create();
                desc.bindEntireConstantBuffer(0, this.sceneBuffer);
                desc.bindEntireConstantBuffer(2, mesh.materialBuffer);
                desc.bindTextureSRV(0, mesh.diffuseTexture);
                desc.bindTextureSRV(1, mesh.specularTexture);
                desc.bindTextureSRV(2, mesh.normalTexture);
                desc.bindSampler(2, this.linearClampSampler);
                this.meshGBufferSets.push(this.app.createBindingSetForLayout(desc, this.gbufferLayout));
            }

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The sample's Menus: the split's labels and center line, the frame rate, the options menu
    // (F1), or the lighting model's label.
    class UserInterface {
        private sample: RaytracingAoSample;

        font: ImGuiFont;

        constructor(sample: RaytracingAoSample) {
            this.sample = sample;
            this.menuLines = [];
            this.menuColors = [];
            this.menuIndex = 0;
        }

        box(x0: number, y0: number, x1: number, y1: number, value: number, alpha: number): void {
            Donut_ImGuiDrawRect(x0, y0, x1, y1, value, value, value, alpha);
        }

        // A label in a 0.2-grey box MENU_BORDER around it (DrawSplitLabels, DrawLabel).
        label(text: string, x: number, y: number, r: number, g: number, b: number): void {
            const width = Donut_ImGuiCalcTextWidth(text);
            this.box(x - MENU_BORDER, y - MENU_BORDER, x + width + MENU_BORDER, y + LINE_SPACING + MENU_BORDER, 0.2, 1.0);
            Donut_ImGuiDrawText(x, y, text, r, g, b, 1.0, 0);
        }

        private menuLines: string[];
        private menuColors: number[];
        private menuIndex: int;

        // Menus::DrawMainMenu's RenderString: a line, its color by whether it is an option (and
        // option `option`, -1 for none) and the selection.
        addMenuLine(text: string, isOption: boolean, option: int): void {
            const sample = this.sample;
            this.menuLines.push(text);
            let r = DARK_GREY;
            let g = DARK_GREY;
            let b = DARK_GREY;
            if (!isOption) {
                r = OFF_WHITE;
                g = OFF_WHITE;
                b = OFF_WHITE;
            } else if (this.menuIndex == sample.selection) {
                r = WHITE;
                g = WHITE;
                b = WHITE;
                // Option::SlectionColor
                if (option >= 0 && sample.options[option].isLowerLimit()) {
                    r = ORANGE[0];
                    g = ORANGE[1];
                    b = ORANGE[2];
                } else if (option >= 0 && sample.options[option].isUpperLimit()) {
                    r = GREEN[0];
                    g = GREEN[1];
                    b = GREEN[2];
                }
            }
            this.menuColors.push(r);
            this.menuColors.push(g);
            this.menuColors.push(b);
            if (isOption) {
                this.menuIndex++;
            }
        }

        optionValue(option: int): string {
            const o = this.sample.options[option];
            return formatFixed(o.value(), o.isInt ? 0 : 2);
        }

        // Menus::DrawMainMenu: centered when split, at the title-safe corner otherwise.
        mainMenu(center: boolean): void {
            const sample = this.sample;
            const screenWidth = sample.frameWidth;
            const screenHeight = sample.frameHeight;
            this.menuLines = [];
            this.menuColors = [];
            this.menuIndex = 0;
            // AO
            this.addMenuLine("AO:", false, -1);
            this.addMenuLine("  Attenuation:", false, -1);
            this.addMenuLine(`      Distance: ${this.optionValue(0)}`, true, 0);
            this.addMenuLine(`      Falloff: ${this.optionValue(1)}`, true, 1);
            this.addMenuLine("  Sampling: ", false, -1);
            this.addMenuLine(`      Num Samples (n^2): ${this.optionValue(2)}`, true, 2);
            this.addMenuLine(`      Type: ${sample.aoSampleType.value() == 0.0 ? "Uniform" : "Cosine"}`, true, -1);
            // SSAO
            this.addMenuLine("SSAO:", false, -1);
            this.addMenuLine("  Tolerance:", false, -1);
            this.addMenuLine(`     Noise Threshold (log10): ${this.optionValue(4)}`, true, 4);
            this.addMenuLine(`     Blur Tolerance (log10): ${this.optionValue(5)}`, true, 5);
            this.addMenuLine(`     Upsample Tolerance (log10): ${this.optionValue(6)}`, true, 6);
            this.addMenuLine("  Misc: ", false, -1);
            this.addMenuLine(`     Normal Factor: ${this.optionValue(7)}`, true, 7);

            let wExtent = 0.0;
            for (let i = 0; i < this.menuLines.length; i++) {
                wExtent = Math.max(wExtent, Donut_ImGuiCalcTextWidth(this.menuLines[i]));
            }
            const height = this.menuLines.length * LINE_SPACING;
            let startX = 0.0;
            let startY = 0.0;
            if (center) {
                startX = (screenWidth - wExtent) / 2.0;
                startY = (screenHeight - height) / 2.0;
            } else {
                // SimpleMath::Viewport::ComputeTitleSafeArea
                startX = Math.floor(Math.fround((screenWidth + 19.0) / 20.0));
                startY = Math.floor(Math.fround((screenHeight + 19.0) / 20.0));
            }
            // Backing: 80% black.
            this.box(startX - MENU_BORDER, startY - MENU_BORDER, startX + wExtent + MENU_BORDER, startY + height + MENU_BORDER, 0.0, 0.8);
            for (let i = 0; i < this.menuLines.length; i++) {
                Donut_ImGuiDrawText(startX, startY + i * LINE_SPACING, this.menuLines[i], this.menuColors[i * 3], this.menuColors[i * 3 + 1],
                    this.menuColors[i * 3 + 2], 1.0, 0);
            }
        }

        // Menus::Draw.
        buildUI(): void {
            const sample = this.sample;
            const screenWidth = sample.frameWidth;
            const screenHeight = sample.frameHeight;
            this.font.push();
            if (sample.isSplit) {
                // DrawSplitLabels
                const ssaoWidth = Donut_ImGuiCalcTextWidth("SSAO");
                this.label("SSAO", ((screenWidth - MENU_LINE_THICKNESS) / 2.0 - ssaoWidth) / 2.0 + MENU_LINE_THICKNESS / 2.0 - MENU_BORDER,
                    screenHeight - LINE_SPACING - MENU_BORDER, WHITE, WHITE, WHITE);
                const aoWidth = Donut_ImGuiCalcTextWidth("AO");
                this.label("AO", ((screenWidth - MENU_LINE_THICKNESS) / 2.0 - aoWidth) / 2.0 + (screenWidth + MENU_LINE_THICKNESS) / 2.0
                    - MENU_BORDER, screenHeight - LINE_SPACING - MENU_BORDER, WHITE, WHITE, WHITE);
                // DrawCenterLine
                const start = (screenWidth - MENU_LINE_THICKNESS) / 2.0;
                this.box(start, 0.0, start + MENU_LINE_THICKNESS, screenHeight, 0.1, 1.0);
            } else {
                // DrawLabel
                const text = sample.lightingModel == LIGHTING_AO ? "AO" : "SSAO";
                const width = Donut_ImGuiCalcTextWidth(text);
                this.label(text, (screenWidth - width) / 2.0, screenHeight - LINE_SPACING - MENU_BORDER, WHITE, WHITE, WHITE);
            }
            if (sample.showFPS) {
                // DrawFrameRate
                const dim = Donut_ImGuiCalcTextWidth("FPS: 0000");
                const text = `FPS: ${sample.fps}`;
                const x = screenWidth - dim - MENU_BORDER;
                this.box(x - MENU_BORDER, 0.0, x + dim + MENU_BORDER, MENU_BORDER + LINE_SPACING + MENU_BORDER, 0.2, 1.0);
                Donut_ImGuiDrawText(x + (dim - Donut_ImGuiCalcTextWidth(text)) / 2.0, MENU_BORDER, text, GREEN[0], GREEN[1], GREEN[2], 1.0, 0);
            }
            if (sample.showHelp) {
                this.mainMenu(sample.isSplit);
            }
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
        Donut_SetAppName("raytracing_ao");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -maze: start with the maze (Space toggles). -full: start not split (S toggles), with
        // -ssao: SSAO rather than AO (Tab toggles). -help: start with the options menu (F1).
        let options = AppOptions.RayTracing | AppOptions.UnormBackBuffer;
        let maze = false;
        let full = false;
        let ssao = false;
        let help = false;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = options | AppOptions.DebugRuntime;
            } else if (arg == "-maze") {
                maze = true;
            } else if (arg == "-full") {
                full = true;
            } else if (arg == "-ssao") {
                ssao = true;
            } else if (arg == "-help") {
                help = true;
            }
        }

        // The sample's B8G8R8A8_UNORM back buffers (UNORM: its outputs copied as they are), at its
        // default 1280 x 720.
        const width = 1280;
        const height = 720;
        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        if (api == GraphicsAPI.D3D11) {
            console.log("This example needs ray tracing: D3D12 or Vulkan");
            return 1;
        }
        const app = App.createWithOptions(api, WINDOW_TITLE, width, height, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        if (app.isFeatureSupported(Feature.RayTracingPipeline) == 0) {
            console.log("The graphics device doesn't support ray tracing pipelines");
            app.destroy();
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const sample = new RaytracingAoSample(app);
        if (!sample.init()) {
            app.destroy();
            return 1;
        }
        const ui = new UserInterface(sample);
        if (!ui.init(app)) {
            app.destroy();
            return 1;
        }
        sample.meshIndex = maze ? 1 : 0;
        sample.isSplit = !full;
        sample.lightingModel = ssao ? LIGHTING_SSAO : LIGHTING_AO;
        sample.showHelp = help;

        const input = new InputPass(app.handle);

        app.run();
        app.destroy();
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return RaytracingAo.main(argc, argv);
}

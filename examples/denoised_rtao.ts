// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { PbrtScene } from "../core/pbrt_scene";
import {
    cross3, matrixInverse, matrixLookAtLH, matrixMultiply, matrixPerspectiveFovLH, matrixRotationY, matrixScaling,
    matrixTranslation, normalize3, radians, transformCoord3, transformNormal3, vadd, vsub,
} from "../core/directx_math";

namespace DenoisedRtao {
    const WINDOW_TITLE = "D3D12 Raytracing Real-Time Denoised Ambient Occlusion";
    // The sample's window (1080p, the G-buffer's and the AO's resolution).
    const WIDTH = 1920;
    const HEIGHT = 1080;
    const ASSETS = "media/denoised_rtao/Assets/";

    // GLFW values, as passed to the keyboard and mouse callbacks.
    const KEY_SPACE = 32;
    const KEY_0 = 48;
    const KEY_1 = 49;
    const KEY_2 = 50;
    const KEY_3 = 51;
    const KEY_4 = 52;
    const KEY_A = 65;
    const KEY_C = 67;
    const KEY_D = 68;
    const KEY_E = 69;
    const KEY_H = 72;
    const KEY_J = 74;
    const KEY_K = 75;
    const KEY_L = 76;
    const KEY_M = 77;
    const KEY_Q = 81;
    const KEY_S = 83;
    const KEY_T = 84;
    const KEY_U = 85;
    const KEY_W = 87;
    const KEY_Y = 89;
    const KEY_ENTER = 257;
    const KEY_LEFT_SHIFT = 340;
    const ACTION_PRESS = 1;
    const ACTION_RELEASE = 0;
    const MOUSE_LEFT = 0;
    const MOUSE_RIGHT = 1;

    // CompositionType (RaytracingHlslCompat.h): the views keys 1 to 3 select.
    const COMPOSITION_PBR_SHADING = 0;
    const COMPOSITION_AO_DENOISED = 1;
    const COMPOSITION_AO_RAW = 2;

    // RaytracingHlslCompat.h's grass straws, and the scene's grass LODs (SceneParameters.h).
    const NUM_GRASS_LODS = 5;
    const MAX_GRASS_STRAWS_1D = 100;
    const N_GRASS_TRIANGLES = 5;
    const N_GRASS_VERTICES = 7;
    const GRASS_PATCH_WIDTH = 14.0;
    const GRASS_PATCH_OFFSET = [-20.0, -1.16, -20.0, 0.0];
    const GRASS_MAX_LOD_DISTANCE = [34.0, 64.0, 120.0, 200.0];
    const GRASS_WIND_STRENGTH = [0.4, 0.11, 0.05, 0.01, 0.0];
    const GRASS_LOD_KD = [0.25, 0.75, 0.25, 0.5, 0.75, 0.5, 0.25, 0.5, 0.5, 0.5, 0.5, 0.75, 0.75, 0.25, 0.75];

    // The vertex layout (VertexPositionNormalTextureTangent, 44 bytes) and PrimitiveMaterialBuffer
    // (24 values); GeometryRecord (8 uints) is the port's stand-in for the sample's shader records.
    const VERTEX_STRIDE = 44;
    const VERTEX_FLOATS = 11;
    const MATERIAL_VALUES = 24;
    const RECORD_VALUES = 8;
    // The geometry records' vertex buffers: the scenes' (0) and the grass LODs' ping-ponged ones
    // (1 + 2 * LOD + vertex buffer index); and the material textures (0 is a placeholder).
    const NUM_VERTEX_BUFFERS = 11;
    const NUM_MATERIAL_TEXTURES = 8;

    // MaterialType::Matte.
    const MATERIAL_TYPE_MATTE = 1;

    // RTAO's sample sets: 1 ray per pixel, sets shared by 8 x 8 pixels, 83 sets.
    const SAMPLES_PER_SET = 64;
    const NUM_SAMPLE_SETS = 83;
    const PIXELS_PER_DIM_PER_SET = 8;
    const MAX_RAY_HIT_TIME = 22.0;

    // The scene's timer (StepTimer): ticks of 100 ns; test runs step it as the reference's fixed
    // 1/60 s step does (TicksPerSecond / 60, an integer).
    const TICKS_PER_SECOND = 10000000;
    const TICKS_PER_FRAME = 166666;

    const MAX_INSTANCES = 1000;

    // Test mode: the frames rendered.
    const TEST_FRAMES = 60;

    // Sets a float array's element to an int's bits (uint fields of constant buffers).
    function storeInt(values: f32[], index: int, value: int): void {
        Donut_StoreInt32(Ref(values[index]), value);
    }

    // A matrix (16 floats, XMMATRIX's memory) into a constant buffer's floats.
    function storeMatrix(values: f32[], index: int, m: number[]): void {
        for (let k = 0; k < 16; k++) {
            values[index + k] = m[k];
        }
    }

    // XMVector3Length's SSE2 order: sqrt((x^2 + z^2) + y^2).
    function length3(v: number[]): number {
        const x2 = Math.fround(v[0] * v[0]);
        const y2 = Math.fround(v[1] * v[1]);
        const z2 = Math.fround(v[2] * v[2]);
        return Math.fround(Math.sqrt(Math.fround(Math.fround(x2 + z2) + y2)));
    }

    // XMVectorScale.
    function vscale(v: number[], s: number): number[] {
        return [Math.fround(v[0] * s), Math.fround(v[1] * s), Math.fround(v[2] * s), Math.fround(v[3] * s)];
    }

    // An XMMATRIX as a TLAS instance's 3x4 transform (XMStoreFloat3x4: rows of the transpose).
    function toTransform3x4(m: number[], out: f32[]): void {
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 4; c++) {
                out[r * 4 + c] = m[c * 4 + r];
            }
        }
    }

    // XMMatrixRotationAxis (normalized axis), for the mouse's pitch (only exact for angle 0,
    // where it's the identity, as the sample's is).
    function matrixRotationAxis(axis: number[], angle: number): number[] {
        const n = normalize3(axis);
        const s = Math.fround(Math.sin(angle));
        const c = Math.fround(Math.cos(angle));
        const t = Math.fround(1.0 - c);
        const x = n[0];
        const y = n[1];
        const z = n[2];
        return [
            Math.fround(t * x * x + c), Math.fround(t * x * y + s * z), Math.fround(t * x * z - s * y), 0.0,
            Math.fround(t * x * y - s * z), Math.fround(t * y * y + c), Math.fround(t * y * z + s * x), 0.0,
            Math.fround(t * x * z + s * y), Math.fround(t * y * z - s * x), Math.fround(t * z * z + c), 0.0,
            0.0, 0.0, 0.0, 1.0,
        ];
    }

    // GameCore::Camera (eye, at, up as XMVECTORs), its projection (45 degrees, near 0.001, far
    // 1000, left-handed) and CameraController::Update: no input still moves the vectors through
    // the same identity rotations and re-adds, as the sample's does every frame.
    class Camera {
        eye: number[];
        at: number[];
        up: number[];

        constructor() {
            this.eye = [0.0, 0.0, 0.0, 1.0];
            this.at = [0.0, 0.0, 1.0, 1.0];
            this.up = [0.0, 1.0, 0.0, 0.0];
        }

        set(eye: number[], at: number[], up: number[]): void {
            this.eye = [eye[0], eye[1], eye[2], 1.0];
            this.at = [at[0], at[1], at[2], 1.0];
            this.up = [up[0], up[1], up[2], 0.0];
        }

        copyFrom(other: Camera): void {
            this.eye = [other.eye[0], other.eye[1], other.eye[2], other.eye[3]];
            this.at = [other.at[0], other.at[1], other.at[2], other.at[3]];
            this.up = [other.up[0], other.up[1], other.up[2], other.up[3]];
        }

        // Camera::GetProj.
        projection(width: int, height: int): number[] {
            const aspectRatio = Math.fround(Math.fround(width) / Math.fround(height));
            let fovAngleY = radians(45.0);
            if (aspectRatio < 1.0) {
                fovAngleY = Math.fround(fovAngleY / aspectRatio);
            }
            return matrixPerspectiveFovLH(fovAngleY, aspectRatio, Math.fround(0.001), 1000.0);
        }

        // Camera::GetViewProj's view.
        view(): number[] {
            return matrixLookAtLH(this.eye, this.at, this.up);
        }

        // XMMatrixLookAtLH from the origin toward at - eye (the sample's "camera at origin" view).
        viewAtOrigin(): number[] {
            const dir = vsub(this.at, this.eye);
            return matrixLookAtLH([0.0, 0.0, 0.0, 1.0], [dir[0], dir[1], dir[2], 1.0], this.up);
        }

        // CameraController::Update's camera moves: RotateAroundYAxis, RotatePitch,
        // TranslateRightUpForward, then the boundary clamp (y >= 0) and Set.
        update(yaw: number, pitch: number, strafe: number, ascent: number, forward: number): void {
            // RotateAroundYAxis.
            const rotation = matrixRotationY(yaw);
            let eye = vadd(this.at, transformCoord3(vsub(this.eye, this.at), rotation));
            let up = transformNormal3(this.up, rotation);
            this.eye = eye;
            this.up = up;
            // RotatePitch.
            const back = vsub(this.eye, this.at);
            const right = cross3(back, this.up);
            const pitchRotation = matrixRotationAxis(right, pitch);
            this.at = vadd(this.eye, transformNormal3(vsub(this.at, this.eye), pitchRotation));
            this.up = transformNormal3(this.up, pitchRotation);
            // TranslateRightUpForward.
            const forwardDir = normalize3(vsub(this.at, this.eye));
            const rightDir = cross3([-forwardDir[0], -forwardDir[1], -forwardDir[2], -forwardDir[3]], this.up);
            const translation = vadd(vadd(vscale(rightDir, strafe), vscale(this.up, ascent)), vscale(forwardDir, forward));
            this.eye = vadd(this.eye, translation);
            this.at = vadd(this.at, translation);
            // The boundaries: y >= 0.
            eye = this.eye;
            const eyeToAt = vsub(this.at, eye);
            if (eye[1] < 0.0) {
                eye = [eye[0], 0.0, eye[2], eye[3]];
            }
            this.set(eye, vadd(eye, eyeToAt), this.up);
        }
    }

    // A constant buffer's size: CBVs span multiples of 256 bytes.
    function constantBufferSize(byteSize: int): int {
        return Math.floor((byteSize + 255) / 256) * 256;
    }

    // A compute pass: a pipeline over a binding layout of a constant buffer (b0) and textures, its
    // constants (floats, ints as their bits) written into it before each dispatch; a constant
    // buffer per dispatch in a frame. (Static constant buffers written in the command list:
    // volatile ones keep 16 versions in flight, which headless runs, unthrottled, exceed.)
    class ComputeKernel {
        pipeline: ComputePipelineHandle;
        layout: BindingLayoutHandle;
        constantBuffers: BufferHandle[];
        constants: f32[];
        constantsSize: int;

        constructor(app: App, shaderFile: string, layoutDesc: BindingLayoutDesc, constantFloats: int, name: string, dispatchesPerFrame: int) {
            layoutDesc.layoutConstantBuffer(0);
            this.layout = app.createBindingLayout(layoutDesc, ShaderType.Compute);
            const shader = app.createShader(shaderFile, "main", ShaderType.Compute);
            this.pipeline = app.createComputePipelineWithLayout(shader, this.layout);
            this.constants = [];
            for (let i = 0; i < constantFloats; i++) {
                this.constants.push(0.0);
            }
            this.constantsSize = constantFloats * 4;
            this.constantBuffers = [];
            for (let i = 0; i < dispatchesPerFrame; i++) {
                this.constantBuffers.push(app.createConstantBuffer(constantBufferSize(this.constantsSize), name));
            }
        }

        // A binding set desc with the index-th constant buffer bound.
        setDesc(index: int): BindingSetDesc {
            const desc = BindingSetDesc.create();
            desc.bindConstantBuffer(0, this.constantBuffers[index], 0, constantBufferSize(this.constantsSize));
            return desc;
        }

        // Dispatches with the constants written into the index-th constant buffer (the one the
        // binding set binds).
        dispatch(commandList: CommandList, index: int, bindingSet: BindingSet, groupsX: int, groupsY: int): void {
            commandList.writeBuffer(this.constantBuffers[index], Ref(this.constants[0]), this.constantsSize);
            commandList.dispatch(this.pipeline, bindingSet, groupsX, groupsY, 1);
        }
    }

    function ceilDivide(value: int, divisor: int): int {
        return Math.floor((value + divisor - 1) / divisor);
    }

    // Port of DirectX-Graphics-Samples' D3D12RaytracingRealTimeDenoisedAmbientOcclusion: ambient
    // occlusion ray traced at one ray per pixel and denoised spatio-temporally, over a scene of
    // PBRT models (a house, two cars, one driving in circles, a dragon, a spaceship, quads and
    // mirrors around them) and 20 patches of procedural grass whose straws a compute shader
    // regenerates in the wind every frame (5 levels of detail by distance; their BLASes rebuilt).
    // Each frame: a specular path tracer (Pathtracer.hlsl) makes the G-buffer (hit positions,
    // normals and depths, motion vectors through mirrors, the albedo of the hit with the largest
    // diffuse contribution); RTAO.hlsl casts an AO ray per pixel from multi-jittered sample sets;
    // the denoiser reprojects its temporal cache into the frame, blends the frame's AO in with
    // variance clamping, filters it with an edge-stopping a-trous 3x3 kernel sized by the AO ray's
    // hit distance, and blurs disoccluded pixels; the composition shows the denoised AO (key 2,
    // the default), the raw one (1), or the path tracer's shading with AO (3).
    //
    // The sample's shader records (a local root signature per geometry: index and vertex buffers,
    // textures, material) are geometry records here, which the hit shaders fetch from a buffer by
    // InstanceID() + GeometryIndex() (the instances' IDs play InstanceContributionToHitGroupIndex's
    // part, the grass LODs' 2 x 3 records per LOD included): one hit group per ray type.
    // The sample's UI (its tuning menu, GPU timers, profiler) and its ground truth mode (key 0, 256
    // rays per pixel) aren't ported; its other keys are.
    class DenoisedRtaoPass {
        private app: App;

        // The scene.
        private sceneVertexBuffer: BufferHandle;
        private indexBuffer: BufferHandle;
        private materialBuffer: BufferHandle;
        private recordBuffer: BufferHandle;
        private materialTextures: TextureHandle[];
        private environmentMap: TextureHandle;
        private sceneBlases: TriangleBlas[];
        // Per scene (in sceneNames' order): its BLAS's first geometry record.
        private sceneRecordBases: int[];
        // The grass: the wind map its straws sway by, its LODs' vertex buffers (two each).
        private windMap: TextureHandle;
        private grassVertexBuffers: BufferHandle[];
        private grassBlases: TriangleBlas[];
        private grassRecordBases: int[];
        private grassIndexOffset: int;
        private topLevelAS: SceneAccelStructs;
        private prevTransformsBuffer: BufferHandle;

        // The instances, in the sample's order: their BLAS (scene index, or -1 - LOD for grass),
        // transform (an XMMATRIX), and this and the previous frame's 3x4 transforms.
        private instanceScenes: int[];
        private instanceTransforms: number[][];
        private instanceRecords: int[];
        private transforms3x4: f32[];
        private prevTransforms3x4: f32[];
        private grassJitter: number[];
        private grassPrevLods: int[];
        private grassFirstInstance: int;
        private currentGrassVertexBuffer: int;
        private animatedCarInstance: int;
        private carByTheHouseInstance: int;
        private spaceshipInstance: int;
        private carByTheHousePosition: number;
        private spaceshipHeight: number;
        private spaceshipAngle: number;

        // Camera and animation (Scene).
        private camera: Camera;
        private prevCamera: Camera;
        private totalTicks: number;
        private elapsedTicks: number;
        private animateScene: boolean;
        private animateCamera: boolean;
        private animateLight: boolean;
        private lightPosition: number[];
        test: boolean;
        // Input for the camera controller: keys held (w, s, a, d, e, q), fine movement, mouse.
        private keys: int[];
        private fineMovement: boolean;
        private mouseButton: int;
        private mouseX: number;
        private mouseY: number;
        private mouseDX: number;
        private mouseDY: number;
        private hasMouse: boolean;
        // Space: render one more frame, then none until pressed again (the scene's time goes on).
        private renderOnce: boolean;
        private framesToRender: int;

        // Settings the keys change.
        compositionMode: int;
        private aoEnabled: boolean;
        private maxRayHitTime: number;

        // The kernels.
        private grassKernel: ComputeKernel;
        private grassSets: BindingSet[];
        private derivativesKernel: ComputeKernel;
        private derivativesSet: BindingSet;
        private reprojectKernel: ComputeKernel;
        private reprojectSets: BindingSet[];
        private meanVarianceKernel: ComputeKernel;
        private meanVarianceSet: BindingSet;
        private blendKernel: ComputeKernel;
        private blendSets: BindingSet[];
        private atrousKernel: ComputeKernel;
        private atrousSets: BindingSet[];
        private blurKernel: ComputeKernel;
        private blurSets: BindingSet[];
        private compositionKernel: ComputeKernel;
        private compositionSets: BindingSet[];

        // The ray tracing passes.
        private pathtracerTable: ShaderTable;
        private pathtracerSet: BindingSet;
        private pathtracerConstants: f32[];
        private pathtracerCB: BufferHandle;
        private rtaoTable: ShaderTable;
        private rtaoSet: BindingSet;
        private rtaoConstants: f32[];
        private rtaoCB: BufferHandle;
        private randomEngine: RandomEngine;
        private checkerboardEvenPixels: boolean;
        private atrousFrame: int;

        // Resources (GBufferResource, AOResource, the denoiser's and the output).
        private gbuffer: TextureHandle[];
        private aoCoefficient: TextureHandle;
        private aoRayHitDistance: TextureHandle;
        private temporalCache: TextureHandle[][];
        private temporalAO: TextureHandle[];
        private cachedValues: TextureHandle;
        private variance: TextureHandle;
        private localMeanVariance: TextureHandle;
        private blurStrength: TextureHandle;
        private prevNormalDepth: TextureHandle;
        private output: TextureHandle;
        private temporalCacheIndex: int;

        constructor(app: App) {
            this.app = app;
            this.materialTextures = [];
            this.sceneBlases = [];
            this.sceneRecordBases = [];
            this.grassVertexBuffers = [];
            this.grassBlases = [];
            this.grassRecordBases = [];
            this.grassIndexOffset = 0;
            this.instanceScenes = [];
            this.instanceTransforms = [];
            this.instanceRecords = [];
            this.transforms3x4 = [];
            this.prevTransforms3x4 = [];
            for (let i = 0; i < MAX_INSTANCES * 12; i++) {
                this.transforms3x4.push(0.0);
                this.prevTransforms3x4.push(0.0);
            }
            this.grassJitter = [];
            this.grassPrevLods = [];
            this.grassFirstInstance = 0;
            this.currentGrassVertexBuffer = 0;
            this.animatedCarInstance = 0;
            this.carByTheHouseInstance = 0;
            this.spaceshipInstance = 0;
            this.carByTheHousePosition = 0.0;
            this.spaceshipHeight = 0.0;
            this.spaceshipAngle = 0.0;
            this.camera = new Camera();
            this.prevCamera = new Camera();
            this.totalTicks = 0;
            this.elapsedTicks = 0;
            this.animateScene = true;
            this.animateCamera = false;
            this.animateLight = false;
            this.lightPosition = [-20.0, 60.0, 20.0, 0.0];
            this.test = false;
            this.keys = [0, 0, 0, 0, 0, 0];
            this.fineMovement = false;
            this.mouseButton = -1;
            this.mouseX = 0.0;
            this.mouseY = 0.0;
            this.mouseDX = 0.0;
            this.mouseDY = 0.0;
            this.hasMouse = false;
            this.renderOnce = false;
            this.framesToRender = 0;
            this.compositionMode = COMPOSITION_AO_DENOISED;
            this.aoEnabled = true;
            this.maxRayHitTime = MAX_RAY_HIT_TIME;
            this.grassSets = [];
            this.reprojectSets = [];
            this.blendSets = [];
            this.atrousSets = [];
            this.compositionSets = [];
            this.blurSets = [];
            this.pathtracerConstants = [];
            for (let i = 0; i < 68; i++) {
                this.pathtracerConstants.push(0.0);
            }
            this.rtaoConstants = [];
            for (let i = 0; i < 20; i++) {
                this.rtaoConstants.push(0.0);
            }
            this.checkerboardEvenPixels = false;
            this.atrousFrame = 0;
            this.gbuffer = [];
            this.temporalCache = [];
            this.temporalAO = [];
            this.temporalCacheIndex = 0;
        }

        onKey(key: int, scancode: int, action: int, mods: int): int {
            const held = [KEY_W, KEY_S, KEY_A, KEY_D, KEY_E, KEY_Q];
            for (let i = 0; i < 6; i++) {
                if (key == held[i] && (action == ACTION_PRESS || action == ACTION_RELEASE)) {
                    this.keys[i] = action == ACTION_PRESS ? 1 : 0;
                    return 1;
                }
            }
            if (action != ACTION_PRESS) {
                return 0;
            }
            if (key == KEY_LEFT_SHIFT) {
                this.fineMovement = !this.fineMovement;
            } else if (key == KEY_1) {
                this.compositionMode = COMPOSITION_AO_RAW;
            } else if (key == KEY_2) {
                this.compositionMode = COMPOSITION_AO_DENOISED;
            } else if (key == KEY_3) {
                this.compositionMode = COMPOSITION_PBR_SHADING;
            } else if (key == KEY_4) {
                // RTAO ray lengths: short or long.
                this.maxRayHitTime = this.maxRayHitTime > 3.9 && this.maxRayHitTime < 4.1 ? 22.0 : 4.0;
            } else if (key == KEY_ENTER) {
                this.aoEnabled = !this.aoEnabled;
            } else if (key == KEY_SPACE) {
                this.renderOnce = !this.renderOnce;
                this.framesToRender = this.renderOnce ? 1 : 0;
            } else if (key == KEY_U) {
                this.carByTheHousePosition = Math.fround(this.carByTheHousePosition + Math.fround(0.2));
            } else if (key == KEY_Y) {
                this.carByTheHousePosition = Math.fround(this.carByTheHousePosition - Math.fround(0.2));
            } else if (key == KEY_J) {
                this.spaceshipHeight = Math.fround(this.spaceshipHeight + Math.fround(0.3));
            } else if (key == KEY_M) {
                this.spaceshipHeight = Math.fround(this.spaceshipHeight - Math.fround(0.3));
            } else if (key == KEY_H) {
                this.spaceshipAngle = Math.fround(this.spaceshipAngle + 45.0);
            } else if (key == KEY_K) {
                this.spaceshipAngle = Math.fround(this.spaceshipAngle - 45.0);
            } else if (key == KEY_L) {
                this.animateLight = !this.animateLight;
            } else if (key == KEY_C) {
                this.animateCamera = !this.animateCamera;
            } else if (key == KEY_T) {
                this.animateScene = !this.animateScene;
            } else if (key == KEY_0) {
                // The sample's ground truth toggle (256 rays per pixel, raw AO): not ported.
                return 1;
            } else {
                return 0;
            }
            this.updateMovableInstances();
            return 1;
        }

        onMousePos(x: number, y: number): int {
            if (this.hasMouse && this.mouseButton >= 0) {
                this.mouseDX += x - this.mouseX;
                this.mouseDY += y - this.mouseY;
            }
            this.mouseX = x;
            this.mouseY = y;
            this.hasMouse = true;
            return 0;
        }

        onMouseButton(button: int, action: int, mods: int): int {
            if (action == ACTION_PRESS && (button == MOUSE_LEFT || button == MOUSE_RIGHT)) {
                this.mouseButton = button;
            } else if (action == ACTION_RELEASE && button == this.mouseButton) {
                this.mouseButton = -1;
            }
            return 0;
        }

        // Scene::OnKeyDown's moves of the car by the house (x in [-9, 0]) and the spaceship (y in
        // [0, 10], turned in 45 degree steps).
        updateMovableInstances(): void {
            if (this.carByTheHousePosition < -9.0) {
                this.carByTheHousePosition = -9.0;
            }
            if (this.carByTheHousePosition > 0.0) {
                this.carByTheHousePosition = 0.0;
            }
            if (this.spaceshipHeight < 0.0) {
                this.spaceshipHeight = 0.0;
            }
            if (this.spaceshipHeight > 10.0) {
                this.spaceshipHeight = 10.0;
            }
            this.instanceTransforms[this.carByTheHouseInstance] = matrixTranslation(this.carByTheHousePosition, 0.0, 0.0);
            this.instanceTransforms[this.spaceshipInstance] = matrixMultiply(matrixTranslation(0.0, this.spaceshipHeight, 0.0),
                matrixRotationY(radians(this.spaceshipAngle)));
        }

        // OnUpdate: the timer, the camera (the previous frame's kept), the animated car, the
        // camera's and the light's rotations when on.
        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
            this.elapsedTicks = this.test ? TICKS_PER_FRAME : Math.floor(elapsedSeconds * TICKS_PER_SECOND);
            this.totalTicks += this.elapsedTicks;
            const elapsedTime = Math.fround(this.elapsedTicks / TICKS_PER_SECOND);

            this.prevCamera.copyFrom(this.camera);
            this.updateCamera(elapsedTime);

            if (this.animateScene) {
                // The car driving in a circle of radius 64 around the scene's center, a lap in 50 s.
                const t = Math.fround(this.totalTicks / TICKS_PER_SECOND);
                const translationSceneCenter = matrixTranslation(-7.0, 0.0, 7.0);
                const translation = matrixTranslation(0.0, 0.0, 64.0);
                const angleToRotateBy = Math.fround(Math.fround(360.0 * -t) / 50.0);
                const rotateSceneCenter = matrixRotationY(radians(-20.0));
                const rotate = matrixRotationY(radians(angleToRotateBy));
                const scale = matrixScaling(1.0, 1.0, 1.0);
                this.instanceTransforms[this.animatedCarInstance] = matrixMultiply(matrixMultiply(matrixMultiply(matrixMultiply(
                    scale, rotateSceneCenter), translation), rotate), translationSceneCenter);
            }

            if (this.animateCamera) {
                // A turn around (5.87519, 0, 8.52134) in 48 s.
                const angle = Math.fround(360.0 * Math.fround(elapsedTime / 48.0));
                const center = [5.87519, 0.0, 8.52134, 0.0];
                const rotate = matrixRotationY(radians(angle));
                const eye = vadd(transformCoord3(vsub(this.camera.eye, center), rotate), center);
                const at = vadd(transformCoord3(vsub(this.camera.at, center), rotate), center);
                this.camera.set(eye, at, transformNormal3(this.camera.up, rotate));
            }
            if (this.animateLight) {
                const angle = Math.fround(-360.0 * Math.fround(elapsedTime / 8.0));
                this.lightPosition = transformCoord3(this.lightPosition, matrixRotationY(radians(angle)));
            }
        }

        // CameraController::Update: WASD move (100 and 250 units a second; Shift: a tenth), E/Q
        // up and down, a mouse drag turns (the left button around the y axis and pitching, the
        // right one the other way).
        updateCamera(elapsedTime: number): void {
            const speedScale = Math.fround((this.fineMovement ? 0.1 : 1.0) * elapsedTime);
            const forwardKeys = this.keys[0] - this.keys[1];
            const strafeKeys = this.keys[3] - this.keys[2];
            const ascentKeys = this.keys[4] - this.keys[5];
            const forward = Math.fround(Math.fround(100.0 * speedScale) * forwardKeys);
            const strafe = Math.fround(Math.fround(250.0 * speedScale) * strafeKeys);
            const ascent = Math.fround(Math.fround(250.0 * speedScale) * ascentKeys);
            let yaw = 0.0;
            let pitch = 0.0;
            if (this.mouseButton >= 0) {
                const sign = this.mouseButton == MOUSE_LEFT ? 1.0 : -1.0;
                yaw = Math.fround(sign * this.mouseDX * 0.0018);
                pitch = Math.fround(-sign * this.mouseDY * 0.0018);
            }
            this.mouseDX = 0.0;
            this.mouseDY = 0.0;
            this.camera.update(yaw, pitch, strafe, ascent, forward);
        }

        // Scene::GenerateGrassGeometry: each LOD's straws into its next vertex buffer, the BLASes
        // pointed at them; then the patches' transforms and levels of detail by their distance to
        // the camera, and their geometry records (by the LOD change from the previous frame).
        generateGrass(commandList: CommandList): void {
            const totalTime = this.animateScene ? Math.fround(this.totalTicks / TICKS_PER_SECOND) : 0.0;
            this.currentGrassVertexBuffer = (this.currentGrassVertexBuffer + 1) % 2;
            const c = this.grassKernel.constants;
            for (let lod = 0; lod < NUM_GRASS_LODS; lod++) {
                // GenerateGrassStrawsConstantBuffer: invActivePatchDim, then the app parameters.
                c[0] = Math.fround(1.0 / MAX_GRASS_STRAWS_1D);
                c[1] = Math.fround(1.0 / MAX_GRASS_STRAWS_1D);
                c[2] = 0.0;
                c[3] = 0.0;
                storeInt(c, 4, MAX_GRASS_STRAWS_1D);
                storeInt(c, 5, MAX_GRASS_STRAWS_1D);
                storeInt(c, 6, MAX_GRASS_STRAWS_1D);
                storeInt(c, 7, MAX_GRASS_STRAWS_1D);
                const timeOffset = Math.fround(Math.fround(totalTime * 1.0) * Math.fround(0.04));
                c[8] = timeOffset;
                c[9] = timeOffset;
                c[10] = Math.fround(0.4);
                c[11] = Math.fround(0.6);
                c[12] = GRASS_PATCH_WIDTH;
                c[13] = GRASS_PATCH_WIDTH;
                c[14] = GRASS_PATCH_WIDTH;
                c[15] = 1.0;
                c[16] = 0.0;
                c[17] = 0.0;
                c[18] = 0.0;
                c[19] = GRASS_WIND_STRENGTH[lod];
                c[20] = 1.0;
                c[21] = 0.0;
                c[22] = 0.0;
                c[23] = 0.0;
                const vbID = this.currentGrassVertexBuffer;
                this.grassKernel.dispatch(commandList, lod, this.grassSets[lod * 2 + vbID],
                    ceilDivide(MAX_GRASS_STRAWS_1D, 8), ceilDivide(MAX_GRASS_STRAWS_1D, 8));
                this.grassBlases[lod].setGeometryVertexBuffer(0, this.grassVertexBuffers[lod * 2 + vbID]);
                this.grassBlases[lod].rebuild(commandList);
            }

            // The patches: offset by the scene's grass offset, jittered a little (the sample's
            // generator, seeded the same every frame), their LOD by distance.
            let instance = this.grassFirstInstance;
            let patch = 0;
            for (let i = 0; i < 30; i++) {
                for (let j = 0; j < 30; j++) {
                    const z = i - 15;
                    const x = j - 15;
                    if (!((x < -1 || x > 2 || z < -2 || z > 1) && (x >= -2 && x <= 3 && z >= -3 && z <= 2))) {
                        continue;
                    }
                    const jitterX = this.grassJitter[patch * 2];
                    const jitterZ = this.grassJitter[patch * 2 + 1];
                    // patchOffset + width * (baseIndex + (x, 0, z) + 0.01 * (jitterX, 0, jitterZ))
                    const base = vadd([0.0, 0.0, 2.0, 0.0], [Math.fround(x), 0.0, Math.fround(z), 0.0]);
                    const jitter = vscale([jitterX, 0.0, jitterZ, 0.0], Math.fround(0.01));
                    const position = vadd(GRASS_PATCH_OFFSET, vscale(vadd(base, jitter), GRASS_PATCH_WIDTH));
                    this.instanceTransforms[instance] = matrixTranslation(position[0], position[1], position[2]);

                    const center = vadd(position, [Math.fround(0.5 * GRASS_PATCH_WIDTH), 0.0, Math.fround(0.5 * GRASS_PATCH_WIDTH), 0.0]);
                    let distance = Math.fround(length3(vsub(center, this.camera.eye)) - Math.fround(0.5 * GRASS_PATCH_WIDTH));
                    if (distance < 0.0) {
                        distance = 0.0;
                    }
                    let lod = NUM_GRASS_LODS - 1;
                    for (let k = 0; k < NUM_GRASS_LODS - 1; k++) {
                        if (distance <= GRASS_MAX_LOD_DISTANCE[k]) {
                            lod = k;
                            break;
                        }
                    }
                    const prevLod = this.grassPrevLods[patch];
                    let transitionType = 1;
                    if (lod > prevLod) {
                        transitionType = 0;
                    } else if (lod < prevLod) {
                        transitionType = 2;
                    }
                    this.instanceScenes[instance] = -1 - lod;
                    this.instanceRecords[instance] = this.grassRecordBases[lod] + this.currentGrassVertexBuffer * 3 + transitionType;
                    this.grassPrevLods[patch] = lod;
                    instance++;
                    patch++;
                }
            }
        }

        // Scene::UpdateAccelerationStructure: the TLAS from this frame's instances, and the
        // previous frame's instance transforms for the motion vectors.
        updateAccelerationStructure(frame: Frame, commandList: CommandList): void {
            let transform: f32[] = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
            const count = this.instanceScenes.length;
            for (let i = 0; i < count; i++) {
                toTransform3x4(this.instanceTransforms[i], transform);
                const sceneIndex = this.instanceScenes[i];
                let blas = this.grassBlases[0];
                if (sceneIndex >= 0) {
                    blas = this.sceneBlases[sceneIndex];
                } else {
                    blas = this.grassBlases[-1 - sceneIndex];
                }
                this.topLevelAS.addInstanceWithHitGroup(blas.getAccelStruct(), 1, this.instanceRecords[i], 0, 0, Ref(transform[0]));
            }
            frame.buildTopLevelAS(this.topLevelAS);

            commandList.writeBuffer(this.prevTransformsBuffer, Ref(this.prevTransforms3x4[0]), MAX_INSTANCES * 48);
            for (let i = 0; i < count; i++) {
                toTransform3x4(this.instanceTransforms[i], transform);
                for (let k = 0; k < 12; k++) {
                    this.prevTransforms3x4[i * 12 + k] = transform[k];
                }
            }
        }

        // Pathtracer::UpdateConstantBuffer (PathtracerConstantBuffer).
        updatePathtracerConstants(): void {
            const c = this.pathtracerConstants;
            const proj = this.camera.projection(WIDTH, HEIGHT);
            const viewProj = matrixMultiply(this.camera.viewAtOrigin(), proj);
            storeMatrix(c, 0, matrixInverse(viewProj));
            c[16] = this.camera.eye[0];
            c[17] = this.camera.eye[1];
            c[18] = this.camera.eye[2];
            storeInt(c, 19, 0);
            c[20] = this.lightPosition[0];
            c[21] = this.lightPosition[1];
            c[22] = this.lightPosition[2];
            storeInt(c, 23, 0);
            c[24] = Math.fround(0.6);
            c[25] = Math.fround(0.6);
            c[26] = Math.fround(0.6);
            c[27] = Math.fround(0.4);
            const prevProj = this.prevCamera.projection(WIDTH, HEIGHT);
            storeMatrix(c, 28, matrixMultiply(this.prevCamera.view(), prevProj));
            storeMatrix(c, 44, matrixInverse(matrixMultiply(this.prevCamera.viewAtOrigin(), prevProj)));
            c[60] = this.prevCamera.eye[0];
            c[61] = this.prevCamera.eye[1];
            c[62] = this.prevCamera.eye[2];
            c[63] = 0.0;
            c[64] = Math.fround(0.001);
            c[65] = 1000.0;
            storeInt(c, 66, 3);
            // Shadow rays only for the shaded view.
            storeInt(c, 67, this.compositionMode == COMPOSITION_PBR_SHADING ? 4 : 0);
        }

        // RTAO::UpdateConstantBuffer (RTAOConstantBuffer): a new seed from the sample's generator.
        updateRtaoConstants(): void {
            const c = this.rtaoConstants;
            storeInt(c, 0, this.randomEngine.uniformUInt(0, -1));
            storeInt(c, 1, SAMPLES_PER_SET);
            storeInt(c, 2, NUM_SAMPLE_SETS);
            storeInt(c, 3, PIXELS_PER_DIM_PER_SET);
            this.checkerboardEvenPixels = !this.checkerboardEvenPixels;
            // The falloff's cutoff: exp(-lambda t^2) = 0.4 with lambda 2.
            const t = Math.fround(Math.sqrt(Math.fround(Math.fround(Math.log(Math.fround(0.4))) / -2.0)));
            c[4] = Math.fround(t * this.maxRayHitTime);
            storeInt(c, 5, 1);
            c[6] = 0.5;
            c[7] = Math.fround(0.07);
            c[8] = this.maxRayHitTime;
            storeInt(c, 9, 0);
            storeInt(c, 10, WIDTH);
            storeInt(c, 11, HEIGHT);
            storeInt(c, 12, 1);
            c[13] = 2.0;
            storeInt(c, 14, 0);
            storeInt(c, 15, this.checkerboardEvenPixels ? 1 : 0);
            storeInt(c, 16, 1);
            c[17] = 0.0;
            c[18] = 0.0;
            c[19] = 0.0;
        }

        // The denoiser (Denoiser::Run): reverse reprojection, the frame's mean and variance, the
        // temporal blend, the a-trous filter and the disocclusion blur.
        denoise(commandList: CommandList): void {
            const previous = this.temporalCacheIndex;
            this.temporalCacheIndex = 1 - this.temporalCacheIndex;
            const current = this.temporalCacheIndex;
            const groupsX = ceilDivide(WIDTH, 8);
            const groupsY = ceilDivide(HEIGHT, 8);

            // TemporalSupersampling_ReverseReprojectConstantBuffer.
            let c = this.reprojectKernel.constants;
            storeInt(c, 0, WIDTH);
            storeInt(c, 1, HEIGHT);
            c[2] = Math.fround(1.0 / WIDTH);
            c[3] = Math.fround(1.0 / HEIGHT);
            c[4] = 1.0;
            storeInt(c, 5, 10);
            storeInt(c, 6, 0);
            c[7] = 0.0;
            this.reprojectKernel.dispatch(commandList, 0, this.reprojectSets[previous], groupsX, groupsY);
            commandList.copyTextureRegion(this.prevNormalDepth, 0, 0, 0, this.gbuffer[1], 0, 0, 0, WIDTH, HEIGHT);

            // CalculateMeanVarianceConstantBuffer: a 9 x 9 kernel.
            c = this.meanVarianceKernel.constants;
            storeInt(c, 0, WIDTH);
            storeInt(c, 1, HEIGHT);
            storeInt(c, 2, 9);
            storeInt(c, 3, 4);
            storeInt(c, 4, 0);
            storeInt(c, 5, this.checkerboardEvenPixels ? 1 : 0);
            storeInt(c, 6, 1);
            c[7] = 0.0;
            this.meanVarianceKernel.dispatch(commandList, 0, this.meanVarianceSet, groupsX, groupsY);

            // TemporalSupersampling_BlendWithCurrentFrameConstantBuffer.
            c = this.blendKernel.constants;
            c[0] = Math.fround(0.6);
            storeInt(c, 1, 1);
            c[2] = Math.fround(0.05);
            c[3] = 0.0;
            c[4] = 4.0;
            storeInt(c, 5, 0);
            c[6] = Math.fround(1.0 / 33.0);
            storeInt(c, 7, 4);
            storeInt(c, 8, 12);
            c[9] = 1.0;
            storeInt(c, 10, 0);
            storeInt(c, 11, this.checkerboardEvenPixels ? 1 : 0);
            this.blendKernel.dispatch(commandList, 0, this.blendSets[current], groupsX, groupsY);

            // AtrousWaveletTransformFilterConstantBuffer: the kernel's radius rotating over 3 frames.
            const rotation = this.atrousFrame % 3;
            this.atrousFrame++;
            c = this.atrousKernel.constants;
            storeInt(c, 0, WIDTH);
            storeInt(c, 1, HEIGHT);
            c[2] = Math.fround(0.2);
            storeInt(c, 3, 0);
            storeInt(c, 4, 1);
            c[5] = Math.fround(rotation / 3.0);
            storeInt(c, 6, 3);
            storeInt(c, 7, Math.floor(Math.fround(Math.fround(1.5 / 100.0) * WIDTH)));
            c[8] = Math.fround(Math.fround(22.0 / this.maxRayHitTime) * Math.fround(0.02));
            // lerp(1, 2, relativeCoef(maxRayHitTime, 4, 22)).
            const coef = Math.fround(Math.fround(this.maxRayHitTime - 4.0) / 18.0);
            c[9] = Math.fround(1.0 + Math.fround(coef * 1.0));
            storeInt(c, 10, 1);
            c[11] = 0.0;
            c[12] = 1.0;
            c[13] = 1.0;
            c[14] = 64.0;
            storeInt(c, 15, 10);
            this.atrousKernel.dispatch(commandList, 0, this.atrousSets[current], ceilDivide(WIDTH, 16), ceilDivide(HEIGHT, 16));

            // Disocclusion blur: 3 passes, a pixel step of 1, 2, 4.
            let step = 1;
            for (let pass = 0; pass < 3; pass++) {
                c = this.blurKernel.constants;
                storeInt(c, 0, WIDTH);
                storeInt(c, 1, HEIGHT);
                storeInt(c, 2, step);
                c[3] = 0.0;
                const widthCS = step * 8 * ceilDivide(WIDTH, step * 8);
                const heightCS = step * 8 * ceilDivide(HEIGHT, step * 8);
                this.blurKernel.dispatch(commandList, pass, this.blurSets[pass], ceilDivide(widthCS, 8), ceilDivide(heightCS, 8));
                step *= 2;
            }
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const commandList = frame.getCommandList();
            if (this.renderOnce && this.framesToRender == 0) {
                // The last frame rendered, again.
                this.app.blitTexture(frame, this.output);
                return;
            }
            this.framesToRender--;

            // Scene::OnRender.
            this.generateGrass(commandList);
            this.updateAccelerationStructure(frame, commandList);

            // Pathtracer::Run: the G-buffer, then the depth's partial derivatives.
            this.updatePathtracerConstants();
            commandList.writeBuffer(this.pathtracerCB, Ref(this.pathtracerConstants[0]), 272);
            frame.dispatchRays(this.pathtracerTable, this.pathtracerSet, WIDTH, HEIGHT);
            const dc = this.derivativesKernel.constants;
            storeInt(dc, 0, WIDTH);
            storeInt(dc, 1, HEIGHT);
            this.derivativesKernel.dispatch(commandList, 0, this.derivativesSet, ceilDivide(WIDTH, 8), ceilDivide(HEIGHT, 8));

            // RTAO::Run.
            this.updateRtaoConstants();
            commandList.writeBuffer(this.rtaoCB, Ref(this.rtaoConstants[0]), 80);
            frame.dispatchRays(this.rtaoTable, this.rtaoSet, WIDTH, HEIGHT);

            this.denoise(commandList);

            // Composition::Render (ComposeRenderPassesConstantBuffer).
            const cc = this.compositionKernel.constants;
            storeInt(cc, 0, this.compositionMode);
            storeInt(cc, 1, this.aoEnabled ? 1 : 0);
            cc[2] = this.maxRayHitTime;
            cc[3] = Math.fround(0.4);
            storeInt(cc, 4, 1);
            cc[5] = 1.0;
            cc[6] = 0.0;
            cc[7] = 0.0;
            const raw = this.compositionMode == COMPOSITION_AO_RAW ? 1 : 0;
            this.compositionKernel.dispatch(commandList, 0, this.compositionSets[this.temporalCacheIndex * 2 + raw],
                ceilDivide(WIDTH, 8), ceilDivide(HEIGHT, 8));

            this.app.blitTexture(frame, this.output);
        }

        // The scenes (Scene::LoadPBRTScene): every mesh of every scene in one vertex and one
        // index buffer, a BLAS per scene of its meshes (non-opaque: the see-through ones and the
        // perfect mirrors, which AO rays skip), their materials and textures.
        loadScenes(commandList: CommandList): boolean {
            const sceneNames = ["spaceship", "groundplane", "car", "dragon", "house", "mirrorquad", "quad"];
            const directory = Donut_GetExecutableDirectory() + "/" + ASSETS;
            let scenes: PbrtScene[] = [];
            let totalVertices = 0;
            let totalIndices = 0;
            for (let s = 0; s < sceneNames.length; s++) {
                const scene = PbrtScene.load(directory + sceneNames[s] + "/scene.pbrt");
                if (scene.isNull()) {
                    console.log(`Cannot load the ${sceneNames[s]} scene (the sample's assets: build with DIRECTX_GRAPHICS_SAMPLES_DIR set)`);
                    return false;
                }
                scenes.push(scene);
                const meshCount = scene.getMeshCount();
                for (let m = 0; m < meshCount; m++) {
                    totalVertices += scene.getMeshVertexCount(m);
                    totalIndices += scene.getMeshIndexCount(m);
                }
            }
            // The grass patch's indices (shared by all LODs) after the scenes'.
            const numStraws = MAX_GRASS_STRAWS_1D * MAX_GRASS_STRAWS_1D;
            const grassIndexCount = numStraws * N_GRASS_TRIANGLES * 3;
            this.grassIndexOffset = totalIndices;

            let vertices: f32[] = [];
            for (let i = 0; i < totalVertices * VERTEX_FLOATS; i++) {
                vertices.push(0.0);
            }
            let indices: int[] = [];
            for (let i = 0; i < totalIndices + grassIndexCount; i++) {
                indices.push(0);
            }
            let materials: f32[] = [];
            let records: int[] = [];
            let textureNames: string[] = [];
            let material: f32[] = [];
            for (let i = 0; i < MATERIAL_VALUES; i++) {
                material.push(0.0);
            }

            this.sceneVertexBuffer = this.app.createAccelStructInputStructuredBuffer(VERTEX_STRIDE, totalVertices, "SceneVertices");
            this.indexBuffer = this.app.createAccelStructInputStructuredBuffer(4, totalIndices + grassIndexCount, "Indices");

            let vertexOffset = 0;
            let indexOffset = 0;
            for (let s = 0; s < scenes.length; s++) {
                const scene = scenes[s];
                const blas = this.app.createEmptyTriangleBlas(sceneNames[s]);
                this.sceneRecordBases.push(Math.floor(records.length / RECORD_VALUES));
                const meshCount = scene.getMeshCount();
                for (let m = 0; m < meshCount; m++) {
                    const vertexCount = scene.getMeshVertexCount(m);
                    const indexCount = scene.getMeshIndexCount(m);
                    scene.copyMeshVertices(m, Ref(vertices[vertexOffset * VERTEX_FLOATS]));
                    scene.copyMeshIndices(m, Ref(indices[indexOffset]));
                    scene.copyMeshMaterial(m, Ref(material[0]));
                    const materialID = Math.floor(materials.length / MATERIAL_VALUES);
                    for (let k = 0; k < MATERIAL_VALUES; k++) {
                        materials.push(material[k]);
                    }
                    // The textures: the house's tiles have an sRGB chunk, which DirectXTK's loader
                    // honors (sRGB textures for the diffuse maps, linear normal maps).
                    const diffuseName = scene.getMeshDiffuseTexture(m);
                    const normalName = scene.getMeshNormalTexture(m);
                    let diffuse = 0;
                    let normal = 0;
                    if (diffuseName != "") {
                        diffuse = this.textureIndex(commandList, textureNames, diffuseName, 1);
                    }
                    if (normalName != "") {
                        normal = this.textureIndex(commandList, textureNames, normalName, 0);
                    }
                    // GeometryRecord.
                    records.push(materialID);
                    records.push(0);
                    records.push(0);
                    records.push(0);
                    records.push(indexOffset);
                    records.push(vertexOffset);
                    records.push(diffuse);
                    records.push(normal);

                    blas.addGeometry(this.indexBuffer, indexOffset * 4, indexCount, this.sceneVertexBuffer, vertexOffset * VERTEX_STRIDE,
                        vertexCount, VERTEX_STRIDE, null);
                    // Opaque unless see-through or a perfect mirror (AO rays skip those).
                    if (scene.isMeshOpaque(m) == 0) {
                        blas.setGeometryFlags(m, 0);
                    }
                    vertexOffset += vertexCount;
                    indexOffset += indexCount;
                }
                this.sceneBlases.push(blas);
                scene.destroy();
            }
            commandList.writeBuffer(this.sceneVertexBuffer, Ref(vertices[0]), totalVertices * VERTEX_STRIDE);

            // Scene::InitializeGrassGeometry: a patch's straws' indices, two vertex buffers per LOD
            // (this and the previous frame's), its material (an LOD color, the grass texture).
            const strawIndices = [0, 2, 1, 1, 2, 3, 2, 4, 3, 3, 4, 5, 4, 6, 5];
            let k = totalIndices;
            for (let i = 0; i < numStraws; i++) {
                const baseVertexID = i * N_GRASS_VERTICES;
                for (let n = 0; n < 15; n++) {
                    indices[k] = baseVertexID + strawIndices[n];
                    k++;
                }
            }
            commandList.writeBuffer(this.indexBuffer, Ref(indices[0]), (totalIndices + grassIndexCount) * 4);
            const grassTexture = this.textureIndex(commandList, textureNames, "grass/albedo.png", 0);
            const grassVertexCount = numStraws * N_GRASS_VERTICES;
            for (let lod = 0; lod < NUM_GRASS_LODS; lod++) {
                for (let vb = 0; vb < 2; vb++) {
                    this.grassVertexBuffers.push(this.app.createRWAccelStructInputStructuredBuffer(VERTEX_STRIDE, grassVertexCount, `GrassLOD${lod}VB${vb}`));
                }
            }
            for (let lod = 0; lod < NUM_GRASS_LODS; lod++) {
                const materialID = Math.floor(materials.length / MATERIAL_VALUES);
                // PrimitiveMaterialBuffer: Kd, Ks 0, Kr 0, Kt 0, opacity 1, eta 1, roughness 0.1,
                // a diffuse texture, matte.
                const values = [GRASS_LOD_KD[lod * 3], GRASS_LOD_KD[lod * 3 + 1], GRASS_LOD_KD[lod * 3 + 2],
                    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.1];
                for (let n = 0; n < 19; n++) {
                    material[n] = Math.fround(values[n]);
                }
                Donut_StoreInt32(Ref(material[19]), 1);
                Donut_StoreInt32(Ref(material[20]), 0);
                Donut_StoreInt32(Ref(material[21]), 0);
                Donut_StoreInt32(Ref(material[22]), MATERIAL_TYPE_MATTE);
                material[23] = 0.0;
                for (let n = 0; n < MATERIAL_VALUES; n++) {
                    materials.push(material[n]);
                }

                // Shader records for this and the previous frame's vertex buffers (2), and the
                // transition from a lower LOD, the same one, or a higher one (3): the previous
                // frame's vertices come from that LOD's buffer.
                this.grassRecordBases.push(Math.floor(records.length / RECORD_VALUES));
                for (let frameID = 0; frameID < 2; frameID++) {
                    const prevFrameID = (frameID + 1) % 2;
                    const lower = lod > 0 ? lod - 1 : lod;
                    const higher = lod < NUM_GRASS_LODS - 1 ? lod + 1 : lod;
                    const prevLods = [lower, lod, higher];
                    for (let transition = 0; transition < 3; transition++) {
                        records.push(materialID);
                        records.push(1);
                        records.push(1 + lod * 2 + frameID);
                        records.push(1 + prevLods[transition] * 2 + prevFrameID);
                        records.push(totalIndices);
                        records.push(0);
                        records.push(grassTexture);
                        records.push(0);
                    }
                }

                const blas = this.app.createEmptyTriangleBlas(`Grass Patch LOD ${lod}`);
                blas.addGeometry(this.indexBuffer, totalIndices * 4, grassIndexCount, this.grassVertexBuffers[lod * 2], 0,
                    grassVertexCount, VERTEX_STRIDE, null);
                this.grassBlases.push(blas);
            }

            // The BLASes, over the buffers' data (the grass's allow updates; the sample rebuilds
            // them every frame anyway).
            for (let s = 0; s < this.sceneBlases.length; s++) {
                this.sceneBlases[s].build(this.app, commandList, AccelStructBuildFlags.PreferFastTrace);
            }
            for (let lod = 0; lod < NUM_GRASS_LODS; lod++) {
                this.grassBlases[lod].build(this.app, commandList, AccelStructBuildFlags.PreferFastTrace | AccelStructBuildFlags.AllowUpdate);
            }

            this.materialBuffer = this.app.createStaticShaderBuffer(commandList, Ref(materials[0]), materials.length * 4, MATERIAL_VALUES * 4, "Materials");
            this.recordBuffer = this.app.createStaticShaderBuffer(commandList, Ref(records[0]), records.length * 4, RECORD_VALUES * 4, "GeometryRecords");
            this.environmentMap = this.app.loadTexture(commandList, ASSETS + "Textures/FlowerRoad/flower_road_8khdri_1kcubemap.BC7.DDS", 0);
            return true;
        }

        // A material texture's index in g_textures, loading it the first time (0: none).
        textureIndex(commandList: CommandList, names: string[], name: string, sRGB: int): int {
            for (let i = 0; i < names.length; i++) {
                if (names[i] == name) {
                    return i + 1;
                }
            }
            let path = name;
            if (name.indexOf(":") < 0) {
                path = ASSETS + name;
            }
            this.materialTextures.push(this.app.loadTexture(commandList, path, sRGB));
            names.push(name);
            return names.length;
        }

        // Scene::InitializeAccelerationStructures' instances: the scenes (identity transforms),
        // the second car driving around, a ring of 12 quads and 12 mirrors around the house, and
        // the grass patches (placed each frame).
        createInstances(): void {
            const sceneOrder = [0, 1, 3, 2, 4];
            for (let i = 0; i < sceneOrder.length; i++) {
                const index = this.instanceScenes.length;
                if (sceneOrder[i] == 2) {
                    this.carByTheHouseInstance = index;
                } else if (sceneOrder[i] == 0) {
                    this.spaceshipInstance = index;
                }
                this.instanceScenes.push(sceneOrder[i]);
                this.instanceRecords.push(this.sceneRecordBases[sceneOrder[i]]);
                this.instanceTransforms.push(matrixScaling(1.0, 1.0, 1.0));
            }
            this.animatedCarInstance = this.instanceScenes.length;
            this.instanceScenes.push(2);
            this.instanceRecords.push(this.sceneRecordBases[2]);
            this.instanceTransforms.push(matrixScaling(1.0, 1.0, 1.0));

            const translationSceneCenter = matrixTranslation(-7.0, 0.0, 7.0);
            const translation = matrixTranslation(0.0, -1.5, 75.0);
            const scale = matrixScaling(10.0, 20.0, 1.0);
            for (let mirror = 0; mirror < 2; mirror++) {
                for (let i = 0; i < 12; i++) {
                    const fraction = mirror == 0 ? Math.fround(Math.fround(2.0 * i) / 24.0) : Math.fround(Math.fround(Math.fround(2.0 * i) + 1.0) / 24.0);
                    const angle = Math.fround(360.0 * fraction);
                    const rotate = matrixRotationY(radians(angle));
                    const sceneIndex = mirror == 0 ? 6 : 5;
                    this.instanceScenes.push(sceneIndex);
                    this.instanceRecords.push(this.sceneRecordBases[sceneIndex]);
                    this.instanceTransforms.push(matrixMultiply(matrixMultiply(matrixMultiply(scale, translation), rotate), translationSceneCenter));
                }
            }

            // The grass patches, jittered by the sample's generator (seeded with 1729 every
            // frame, so the same each frame).
            this.grassFirstInstance = this.instanceScenes.length;
            const generator = this.app.createRandomEngine(1729);
            for (let i = 0; i < 30; i++) {
                for (let j = 0; j < 30; j++) {
                    const z = i - 15;
                    const x = j - 15;
                    if (!((x < -1 || x > 2 || z < -2 || z > 1) && (x >= -2 && x <= 3 && z >= -3 && z <= 2))) {
                        continue;
                    }
                    // uniform_real_distribution<float>(0, nextafter(1, FLT_MAX)), as 2 r - 1.
                    const jitterX = Math.fround(Math.fround(2.0 * generator.uniformFloat(0.0, 1.00000011920928955)) - 1.0);
                    const jitterZ = Math.fround(Math.fround(2.0 * generator.uniformFloat(0.0, 1.00000011920928955)) - 1.0);
                    this.grassJitter.push(jitterX);
                    this.grassJitter.push(jitterZ);
                    this.grassPrevLods.push(0);
                    this.instanceScenes.push(-1);
                    this.instanceRecords.push(this.grassRecordBases[0]);
                    this.instanceTransforms.push(matrixScaling(1.0, 1.0, 1.0));
                }
            }
        }

        // A texture the passes write (UAV) and read, cleared to 0.
        createTarget(commandList: CommandList, format: Format, isUInt: boolean, name: string): TextureHandle {
            const texture = this.app.createUAVTextureWithFormat(WIDTH, HEIGHT, format, name);
            if (isUInt) {
                commandList.clearTextureUInt(texture, 0);
            } else {
                commandList.clearTextureFloat(texture, 0.0, 0.0, 0.0, 0.0);
            }
            return texture;
        }

        createTargets(commandList: CommandList): void {
            // GBufferResource: hit position, normal and depth, depth, partial depth derivatives,
            // motion vector, reprojected normal and depth, color, AO surface albedo.
            this.gbuffer.push(this.createTarget(commandList, Format.RGBA32_FLOAT, false, "GBufferHitPosition"));
            this.gbuffer.push(this.createTarget(commandList, Format.R32_UINT, true, "GBufferNormalDepth"));
            this.gbuffer.push(this.createTarget(commandList, Format.R16_FLOAT, false, "GBufferDepth"));
            this.gbuffer.push(this.createTarget(commandList, Format.RG16_FLOAT, false, "GBufferPartialDepthDerivatives"));
            this.gbuffer.push(this.createTarget(commandList, Format.RG16_FLOAT, false, "GBufferMotionVector"));
            this.gbuffer.push(this.createTarget(commandList, Format.R32_UINT, true, "GBufferReprojectedNormalDepth"));
            this.gbuffer.push(this.createTarget(commandList, Format.RGBA8_UNORM, false, "GBufferColor"));
            this.gbuffer.push(this.createTarget(commandList, Format.R11G11B10_FLOAT, false, "GBufferAOSurfaceAlbedo"));
            this.aoCoefficient = this.createTarget(commandList, Format.R16_FLOAT, false, "AOCoefficient");
            this.aoRayHitDistance = this.createTarget(commandList, Format.R16_FLOAT, false, "AORayHitDistance");
            // The temporal cache, twice: tspp, the coefficient's squared mean, the ray hit distance.
            for (let i = 0; i < 2; i++) {
                const cache: TextureHandle[] = [];
                cache.push(this.createTarget(commandList, Format.R8_UINT, true, "TemporalCacheTspp"));
                cache.push(this.createTarget(commandList, Format.R16_FLOAT, false, "TemporalCacheRayHitDistance"));
                cache.push(this.createTarget(commandList, Format.R16_FLOAT, false, "TemporalCacheCoefficientSquaredMean"));
                this.temporalCache.push(cache);
                this.temporalAO.push(this.createTarget(commandList, Format.R16_FLOAT, false, "TemporalAOCoefficient"));
            }
            this.cachedValues = this.createTarget(commandList, Format.RGBA16_UINT, true, "ReprojectedTsppValueSquaredValueRayHitDistance");
            this.variance = this.createTarget(commandList, Format.R16_FLOAT, false, "Variance");
            this.localMeanVariance = this.createTarget(commandList, Format.RG16_FLOAT, false, "LocalMeanVariance");
            this.blurStrength = this.createTarget(commandList, Format.R8_UNORM, false, "DisocclusionBlurStrength");
            this.prevNormalDepth = this.createTarget(commandList, Format.R32_UINT, true, "PrevFrameGBufferNormalDepth");
            this.output = this.createTarget(commandList, Format.RGBA8_UNORM, false, "RaytracingOutput");
        }

        // The ray tracing pipelines: the path tracer's (radiance and shadow rays, recursion 5) and
        // RTAO's, with their global bindings (the sample's global root signatures).
        createRayTracing(): boolean {
            const anisotropicWrap = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Wrap, 0.0, 0.0, 3.402823466e+38, 16.0);

            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutAccelStruct(0);
            layoutDesc.layoutConstantBuffer(0);
            layoutDesc.layoutStructuredBufferSRV(3);
            layoutDesc.layoutStructuredBufferSRV(5);
            layoutDesc.layoutStructuredBufferSRV(6);
            layoutDesc.layoutTextureSRV(12);
            layoutDesc.layoutStructuredBufferSRV(15);
            layoutDesc.layoutStructuredBufferSRVArray(16, NUM_VERTEX_BUFFERS);
            layoutDesc.layoutTextureSRVArray(32, NUM_MATERIAL_TEXTURES);
            layoutDesc.layoutTextureUAV(7);
            layoutDesc.layoutTextureUAV(8);
            layoutDesc.layoutTextureUAV(9);
            layoutDesc.layoutTextureUAV(17);
            layoutDesc.layoutTextureUAV(18);
            layoutDesc.layoutTextureUAV(19);
            layoutDesc.layoutTextureUAV(20);
            layoutDesc.layoutSampler(0);
            const layout = this.app.createBindingLayout(layoutDesc, ShaderType.All);
            this.pathtracerCB = this.app.createConstantBuffer(constantBufferSize(272), "PathtracerConstants");
            this.prevTransformsBuffer = this.app.createStructuredBuffer(48, MAX_INSTANCES, "PrevFrameInstanceTransforms");

            const setDesc = BindingSetDesc.create();
            setDesc.bindAccelStruct(0, this.topLevelAS.getTopLevelAS());
            setDesc.bindConstantBuffer(0, this.pathtracerCB, 0, constantBufferSize(272));
            setDesc.bindStructuredBufferSRV(3, this.materialBuffer);
            setDesc.bindStructuredBufferSRV(5, this.recordBuffer);
            setDesc.bindStructuredBufferSRV(6, this.indexBuffer);
            setDesc.bindTextureSRV(12, this.environmentMap);
            setDesc.bindStructuredBufferSRV(15, this.prevTransformsBuffer);
            setDesc.bindStructuredBufferSRVArrayElement(16, 0, this.sceneVertexBuffer);
            for (let i = 0; i < NUM_VERTEX_BUFFERS - 1; i++) {
                setDesc.bindStructuredBufferSRVArrayElement(16, i + 1, this.grassVertexBuffers[i]);
            }
            for (let i = 0; i < NUM_MATERIAL_TEXTURES; i++) {
                const texture = i > 0 && i <= this.materialTextures.length ? this.materialTextures[i - 1] : this.materialTextures[0];
                setDesc.bindTextureSRVArrayElement(32, i, texture);
            }
            const gbufferSlots = [7, 8, 9, -1, 17, 18, 19, 20];
            for (let i = 0; i < 8; i++) {
                if (gbufferSlots[i] >= 0) {
                    setDesc.bindTextureUAV(gbufferSlots[i], this.gbuffer[i]);
                }
            }
            setDesc.bindSampler(0, anisotropicWrap);
            this.pathtracerSet = this.app.createBindingSetForLayout(setDesc, layout);

            const library = this.app.createShaderLibrary("denoised_rtao/Pathtracer.hlsl");
            if (!library) {
                return false;
            }
            const pipelineDesc = RtPipelineDesc.create(64, 5);
            pipelineDesc.addGlobalBindingLayout(layout);
            pipelineDesc.addShader(library, "MyRayGenShader_RadianceRay", ShaderType.RayGeneration);
            pipelineDesc.addShader(library, "MyMissShader_RadianceRay", ShaderType.Miss);
            pipelineDesc.addShader(library, "MyMissShader_ShadowRay", ShaderType.Miss);
            pipelineDesc.addHitGroup(library, "MyHitGroup_Triangle_RadianceRay", "MyClosestHitShader_RadianceRay", "", null);
            pipelineDesc.addHitGroup(library, "MyHitGroup_Triangle_ShadowRay", "MyClosestHitShader_ShadowRay", "", null);
            const pipeline = this.app.createRayTracingPipelineFromDesc(pipelineDesc);
            if (!pipeline) {
                return false;
            }
            const table = this.app.createEmptyShaderTable(pipeline);
            this.app.releaseResource(pipeline);
            table.setRayGeneration("MyRayGenShader_RadianceRay");
            table.addMiss("MyMissShader_RadianceRay");
            table.addMiss("MyMissShader_ShadowRay");
            table.addHitGroup("MyHitGroup_Triangle_RadianceRay", null);
            table.addHitGroup("MyHitGroup_Triangle_ShadowRay", null);
            this.pathtracerTable = table;

            // RTAO: the G-buffer in, the AO coefficient and ray hit distance out.
            const aoLayoutDesc = BindingLayoutDesc.create();
            aoLayoutDesc.layoutAccelStruct(0);
            aoLayoutDesc.layoutConstantBuffer(0);
            aoLayoutDesc.layoutStructuredBufferSRV(4);
            aoLayoutDesc.layoutTextureSRV(7);
            aoLayoutDesc.layoutTextureSRV(8);
            aoLayoutDesc.layoutTextureSRV(24);
            aoLayoutDesc.layoutTextureUAV(10);
            aoLayoutDesc.layoutTextureUAV(15);
            const aoLayout = this.app.createBindingLayout(aoLayoutDesc, ShaderType.All);
            this.rtaoCB = this.app.createConstantBuffer(constantBufferSize(80), "RTAOConstants");

            // The sample sets (AlignedHemisphereSample3D).
            let samples: f32[] = [];
            for (let i = 0; i < SAMPLES_PER_SET * NUM_SAMPLE_SETS * 4; i++) {
                samples.push(0.0);
            }
            Donut_GenerateRtaoHemisphereSamples(SAMPLES_PER_SET, NUM_SAMPLE_SETS, Ref(samples[0]));
            const commandList = this.app.createCommandList();
            commandList.open();
            const sampleBuffer = this.app.createStaticShaderBuffer(commandList, Ref(samples[0]), samples.length * 4, 16, "HemisphereSamples");
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);

            const aoSetDesc = BindingSetDesc.create();
            aoSetDesc.bindAccelStruct(0, this.topLevelAS.getTopLevelAS());
            aoSetDesc.bindConstantBuffer(0, this.rtaoCB, 0, constantBufferSize(80));
            aoSetDesc.bindStructuredBufferSRV(4, sampleBuffer);
            aoSetDesc.bindTextureSRV(7, this.gbuffer[0]);
            aoSetDesc.bindTextureSRV(8, this.gbuffer[1]);
            aoSetDesc.bindTextureSRV(24, this.gbuffer[7]);
            aoSetDesc.bindTextureUAV(10, this.aoCoefficient);
            aoSetDesc.bindTextureUAV(15, this.aoRayHitDistance);
            this.rtaoSet = this.app.createBindingSetForLayout(aoSetDesc, aoLayout);

            const aoLibrary = this.app.createShaderLibrary("denoised_rtao/RTAO.hlsl");
            if (!aoLibrary) {
                return false;
            }
            const aoPipelineDesc = RtPipelineDesc.create(4, 1);
            aoPipelineDesc.addGlobalBindingLayout(aoLayout);
            aoPipelineDesc.addShader(aoLibrary, "RayGenShader", ShaderType.RayGeneration);
            aoPipelineDesc.addShader(aoLibrary, "MissShader", ShaderType.Miss);
            aoPipelineDesc.addHitGroup(aoLibrary, "HitGroup", "ClosestHitShader", "", null);
            const aoPipeline = this.app.createRayTracingPipelineFromDesc(aoPipelineDesc);
            if (!aoPipeline) {
                return false;
            }
            const aoTable = this.app.createEmptyShaderTable(aoPipeline);
            this.app.releaseResource(aoPipeline);
            aoTable.setRayGeneration("RayGenShader");
            aoTable.addMiss("MissShader");
            aoTable.addHitGroup("HitGroup", null);
            this.rtaoTable = aoTable;
            return true;
        }

        // The compute passes and their bindings (the sample's compute root signatures).
        createKernels(): void {
            // GenerateGrassStrawsCS: the wind map (linear, wrapping), a vertex buffer out.
            const windMap = this.windMap;
            let desc = BindingLayoutDesc.create();
            desc.layoutTextureSRV(0);
            desc.layoutStructuredBufferUAV(0);
            desc.layoutSampler(0);
            this.grassKernel = new ComputeKernel(this.app, "denoised_rtao/GenerateGrassStrawsCS.hlsl", desc, 24, "GrassConstants", NUM_GRASS_LODS);
            const linearWrap = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Wrap, 0.0, 0.0, 3.402823466e+38, 1.0);
            for (let i = 0; i < NUM_GRASS_LODS * 2; i++) {
                const setDesc = this.grassKernel.setDesc(Math.floor(i / 2));
                setDesc.bindTextureSRV(0, windMap);
                setDesc.bindStructuredBufferUAV(0, this.grassVertexBuffers[i]);
                setDesc.bindSampler(0, linearWrap);
                this.grassSets.push(this.app.createBindingSetForLayout(setDesc, this.grassKernel.layout));
            }

            // CalculatePartialDerivativesViaCentralDifferencesCS: the depth in, its derivatives out.
            desc = BindingLayoutDesc.create();
            desc.layoutTextureSRV(0);
            desc.layoutTextureUAV(0);
            this.derivativesKernel = new ComputeKernel(this.app, "denoised_rtao/CalculatePartialDerivativesViaCentralDifferencesCS.hlsl", desc, 4,
                "PartialDerivativesConstants", 1);
            let setDesc = this.derivativesKernel.setDesc(0);
            setDesc.bindTextureSRV(0, this.gbuffer[2]);
            setDesc.bindTextureUAV(0, this.gbuffer[3]);
            this.derivativesSet = this.app.createBindingSetForLayout(setDesc, this.derivativesKernel.layout);

            // TemporalSupersampling_ReverseReprojectCS, per previous temporal cache.
            desc = BindingLayoutDesc.create();
            for (let t = 0; t < 9; t++) {
                desc.layoutTextureSRV(t);
            }
            desc.layoutTextureUAV(0);
            desc.layoutTextureUAV(1);
            desc.layoutSampler(0);
            this.reprojectKernel = new ComputeKernel(this.app, "denoised_rtao/TemporalSupersampling_ReverseReprojectCS.hlsl", desc, 8,
                "ReverseReprojectConstants", 1);
            const pointClamp = this.app.createSamplerWithDesc(0, 0, 0, SamplerAddressMode.Clamp, 0.0, 0.0, 3.402823466e+38, 1.0);
            for (let previous = 0; previous < 2; previous++) {
                const current = 1 - previous;
                setDesc = this.reprojectKernel.setDesc(0);
                setDesc.bindTextureSRV(0, this.gbuffer[1]);
                setDesc.bindTextureSRV(1, this.gbuffer[3]);
                setDesc.bindTextureSRV(2, this.gbuffer[5]);
                setDesc.bindTextureSRV(3, this.gbuffer[4]);
                setDesc.bindTextureSRV(4, this.prevNormalDepth);
                // The previous frame's denoised AO (the AO coefficients' index is the same at
                // the start of every frame: it flips twice per frame).
                setDesc.bindTextureSRV(5, this.temporalAO[0]);
                setDesc.bindTextureSRV(6, this.temporalCache[previous][0]);
                setDesc.bindTextureSRV(7, this.temporalCache[previous][2]);
                setDesc.bindTextureSRV(8, this.temporalCache[previous][1]);
                setDesc.bindTextureUAV(0, this.temporalCache[current][0]);
                setDesc.bindTextureUAV(1, this.cachedValues);
                setDesc.bindSampler(0, pointClamp);
                this.reprojectSets.push(this.app.createBindingSetForLayout(setDesc, this.reprojectKernel.layout));
            }

            // CalculateMeanVarianceCS: the frame's AO in, its local mean and variance out.
            desc = BindingLayoutDesc.create();
            desc.layoutTextureSRV(0);
            desc.layoutTextureUAV(0);
            this.meanVarianceKernel = new ComputeKernel(this.app, "denoised_rtao/CalculateMeanVarianceCS.hlsl", desc, 8, "MeanVarianceConstants", 1);
            setDesc = this.meanVarianceKernel.setDesc(0);
            setDesc.bindTextureSRV(0, this.aoCoefficient);
            setDesc.bindTextureUAV(0, this.localMeanVariance);
            this.meanVarianceSet = this.app.createBindingSetForLayout(setDesc, this.meanVarianceKernel.layout);

            // TemporalSupersampling_BlendWithCurrentFrameCS, per current temporal cache.
            desc = BindingLayoutDesc.create();
            for (let t = 0; t < 4; t++) {
                desc.layoutTextureSRV(t);
            }
            for (let u = 0; u < 6; u++) {
                desc.layoutTextureUAV(u);
            }
            this.blendKernel = new ComputeKernel(this.app, "denoised_rtao/TemporalSupersampling_BlendWithCurrentFrameCS.hlsl", desc, 12,
                "BlendWithCurrentFrameConstants", 1);
            for (let current = 0; current < 2; current++) {
                setDesc = this.blendKernel.setDesc(0);
                setDesc.bindTextureSRV(0, this.aoCoefficient);
                setDesc.bindTextureSRV(1, this.localMeanVariance);
                setDesc.bindTextureSRV(2, this.aoRayHitDistance);
                setDesc.bindTextureSRV(3, this.cachedValues);
                setDesc.bindTextureUAV(0, this.temporalAO[1]);
                setDesc.bindTextureUAV(1, this.temporalCache[current][0]);
                setDesc.bindTextureUAV(2, this.temporalCache[current][2]);
                setDesc.bindTextureUAV(3, this.temporalCache[current][1]);
                setDesc.bindTextureUAV(4, this.variance);
                setDesc.bindTextureUAV(5, this.blurStrength);
                this.blendSets.push(this.app.createBindingSetForLayout(setDesc, this.blendKernel.layout));
            }

            // EdgeStoppingFilter_Gaussian3x3CS (the a-trous filter), per current temporal cache.
            desc = BindingLayoutDesc.create();
            desc.layoutTextureSRV(0);
            desc.layoutTextureSRV(1);
            desc.layoutTextureSRV(4);
            desc.layoutTextureSRV(6);
            desc.layoutTextureSRV(7);
            desc.layoutTextureSRV(8);
            desc.layoutTextureUAV(0);
            this.atrousKernel = new ComputeKernel(this.app, "denoised_rtao/EdgeStoppingFilter_Gaussian3x3CS.hlsl", desc, 16, "AtrousConstants", 1);
            for (let current = 0; current < 2; current++) {
                setDesc = this.atrousKernel.setDesc(0);
                setDesc.bindTextureSRV(0, this.temporalAO[1]);
                setDesc.bindTextureSRV(1, this.gbuffer[1]);
                setDesc.bindTextureSRV(4, this.variance);
                setDesc.bindTextureSRV(6, this.temporalCache[current][1]);
                setDesc.bindTextureSRV(7, this.gbuffer[3]);
                setDesc.bindTextureSRV(8, this.temporalCache[current][0]);
                setDesc.bindTextureUAV(0, this.temporalAO[0]);
                this.atrousSets.push(this.app.createBindingSetForLayout(setDesc, this.atrousKernel.layout));
            }

            // DisocclusionBlur3x3CS: the denoised AO blurred in place by the blur strength.
            desc = BindingLayoutDesc.create();
            desc.layoutTextureSRV(1);
            desc.layoutTextureSRV(2);
            desc.layoutTextureUAV(0);
            this.blurKernel = new ComputeKernel(this.app, "denoised_rtao/DisocclusionBlur3x3CS.hlsl", desc, 4, "DisocclusionBlurConstants", 3);
            for (let pass = 0; pass < 3; pass++) {
                setDesc = this.blurKernel.setDesc(pass);
                setDesc.bindTextureSRV(1, this.gbuffer[2]);
                setDesc.bindTextureSRV(2, this.blurStrength);
                setDesc.bindTextureUAV(0, this.temporalAO[0]);
                this.blurSets.push(this.app.createBindingSetForLayout(setDesc, this.blurKernel.layout));
            }

            // CompositionCS, per current temporal cache and AO (denoised or raw).
            desc = BindingLayoutDesc.create();
            desc.layoutTextureUAV(0);
            desc.layoutTextureSRV(2);
            desc.layoutTextureSRV(3);
            desc.layoutTextureSRV(5);
            desc.layoutStructuredBufferSRV(7);
            desc.layoutTextureSRV(9);
            desc.layoutTextureSRV(10);
            desc.layoutTextureSRV(11);
            desc.layoutTextureSRV(12);
            desc.layoutTextureSRV(13);
            desc.layoutTextureSRV(14);
            this.compositionKernel = new ComputeKernel(this.app, "denoised_rtao/CompositionCS.hlsl", desc, 8, "CompositionConstants", 1);
            for (let current = 0; current < 2; current++) {
                for (let raw = 0; raw < 2; raw++) {
                    setDesc = this.compositionKernel.setDesc(0);
                    setDesc.bindTextureUAV(0, this.output);
                    setDesc.bindTextureSRV(2, this.gbuffer[0]);
                    setDesc.bindTextureSRV(3, this.gbuffer[1]);
                    setDesc.bindTextureSRV(5, raw == 1 ? this.aoCoefficient : this.temporalAO[0]);
                    setDesc.bindStructuredBufferSRV(7, this.materialBuffer);
                    setDesc.bindTextureSRV(9, this.temporalCache[current][1]);
                    setDesc.bindTextureSRV(10, this.temporalCache[current][0]);
                    setDesc.bindTextureSRV(11, this.gbuffer[6]);
                    setDesc.bindTextureSRV(12, this.gbuffer[7]);
                    setDesc.bindTextureSRV(13, this.variance);
                    setDesc.bindTextureSRV(14, this.localMeanVariance);
                    this.compositionSets.push(this.app.createBindingSetForLayout(setDesc, this.compositionKernel.layout));
                }
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            // Blitting creates Donut's common passes: before any command list is open.
            this.app.getCommonSampler(CommonSampler.LinearClamp);

            // The camera (SampleScene::Initialize) and the RTAO seed generator (seeded with 1729).
            this.camera.set([-38.5863, 13.9563, -24.2481, 1.0], [-37.9042, 13.5773, -23.6219, 1.0], [0.351221, 0.877166, 0.32744, 0.0]);
            for (let k = 0; k < 4; k++) {
                this.camera.eye[k] = Math.fround(this.camera.eye[k]);
                this.camera.at[k] = Math.fround(this.camera.at[k]);
                this.camera.up[k] = Math.fround(this.camera.up[k]);
            }
            this.prevCamera.copyFrom(this.camera);
            this.randomEngine = this.app.createRandomEngine(1729);

            const commandList = this.app.createCommandList();
            commandList.open();
            const ok = this.loadScenes(commandList);
            if (ok) {
                // The grass's wind map, decoded by WIC as the sample's loader does.
                const windPath = Donut_GetExecutableDirectory() + "/" + ASSETS + "wind/wind2.jpg";
                const size = Donut_DecodeWicImageRGBA8(windPath, null);
                const width = size & 0xFFFF;
                const height = (size >> 16) & 0xFFFF;
                let pixels: int[] = [];
                for (let i = 0; i < width * height; i++) {
                    pixels.push(0);
                }
                Donut_DecodeWicImageRGBA8(windPath, Ref(pixels[0]));
                this.windMap = this.app.createTextureWithLevels(width, height, 1, Format.RGBA8_UNORM, "WindMap");
                commandList.writeTextureLevel(this.windMap, 0, Ref(pixels[0]), width * 4);
                this.createTargets(commandList);
            }
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);
            if (!ok) {
                return false;
            }

            this.createInstances();
            this.topLevelAS = this.app.createTopLevelASWithFlags(MAX_INSTANCES, AccelStructBuildFlags.PreferFastTrace);
            if (!this.createRayTracing()) {
                return false;
            }
            this.createKernels();

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setAnimateCallback(this.onAnimate);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // -test: checks the last frame. The AO views: lit open ground (bright) with occlusion around
    // the house, cars and grass (darker pixels); the denoised AO smooth (few neighboring pixels
    // differ much), the raw one noisy (many do: the denoiser is what smooths it). The shaded view:
    // colored (the cars, the dragon, the grass) as well as gray.
    function checkFrame(app: App, mode: int): string {
        const width = app.getWindowWidth();
        const height = app.getWindowHeight();
        let pixels: int[] = [];
        for (let i = 0; i < width * height; i++) {
            pixels.push(0);
        }
        if (app.readBackBufferRGBA8(Ref(pixels[0]), pixels.length) == 0) {
            return "cannot read the back buffer";
        }
        let sum = 0;
        let dark = 0;
        let rough = 0;
        let colored = 0;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const p = pixels[y * width + x];
                const v = p & 0xFF;
                const g = (p >> 8) & 0xFF;
                const b = (p >> 16) & 0xFF;
                sum += v;
                if (v < 128) {
                    dark++;
                }
                const rg = v > g ? v - g : g - v;
                const gb = g > b ? g - b : b - g;
                if (rg > 40 || gb > 40) {
                    colored++;
                }
                if (x + 1 < width) {
                    const r = pixels[y * width + x + 1] & 0xFF;
                    const d = v > r ? v - r : r - v;
                    if (d > 48) {
                        rough++;
                    }
                }
            }
        }
        const count = width * height;
        const mean = sum / count;
        const darkFraction = dark / count;
        const roughFraction = rough / count;
        const coloredFraction = colored / count;
        console.log(`Mean ${mean}, dark fraction ${darkFraction}, rough fraction ${roughFraction}, colored fraction ${coloredFraction}`);
        if (mode == COMPOSITION_PBR_SHADING) {
            if (coloredFraction < 0.04) {
                return `only ${coloredFraction} of the pixels are colored in the shaded view`;
            }
            return "";
        }
        if (mean < 100 || mean > 250) {
            return `mean brightness ${mean} is not in [100, 250]`;
        }
        if (darkFraction < 0.01) {
            return `only ${darkFraction} of the pixels are occluded (dark)`;
        }
        if (coloredFraction > 0.001) {
            return `${coloredFraction} of the AO view's pixels are colored`;
        }
        if (mode == COMPOSITION_AO_RAW) {
            if (roughFraction < 0.1) {
                return `${roughFraction} of the neighboring pixels differ much: the raw AO isn't noisy`;
            }
        } else if (roughFraction > 0.05) {
            return `${roughFraction} of the neighboring pixels differ much: not denoised`;
        }
        return "";
    }

    class DenoisedRtaoArgs extends Args {
        // -raw / -shaded: start in the raw AO (key 1) or shaded (key 3) view.
        mode: int = COMPOSITION_AO_DENOISED;

        protected parseOptions(): void {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-raw") {
                    this.mode = COMPOSITION_AO_RAW;
                } else if (arg == "-shaded") {
                    this.mode = COMPOSITION_PBR_SHADING;
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("denoised_rtao");

        // -test [-testOutput <file>]: render 60 frames (at 60 a second) without a window and check
        // the last one (see checkFrame).
        const args = new DenoisedRtaoArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        // UNORM back buffers, as the sample's R8G8B8A8_UNORM.
        const options = AppOptions.UnormBackBuffer | AppOptions.RayTracing | args.options;
        const app = App.createWithOptions(args.api, WINDOW_TITLE, WIDTH, HEIGHT, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        if (app.isFeatureSupported(Feature.RayTracingPipeline) == 0) {
            console.log("Ray tracing pipelines are not supported by this device");
            app.destroy();
            return 1;
        }

        const pass = new DenoisedRtaoPass(app);
        pass.test = args.test;
        pass.compositionMode = args.mode;
        if (!pass.init()) {
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        let result = 0;
        if (args.test) {
            result = app.finishTest(checkFrame(app, args.mode));
        }
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return DenoisedRtao.main(argc, argv);
}

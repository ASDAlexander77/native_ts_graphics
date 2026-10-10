// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import {
    cross3, matrixIdentity, matrixInverse, matrixLookAtLH, matrixMultiply, matrixPerspectiveFovLH,
    matrixRotationY, matrixScaling, matrixTranslation, normalize3, normalize4, radians, transform3, vsub,
} from "../core/directx_math";

namespace ProceduralGeometry {
    const WINDOW_TITLE = "D3D12 Raytracing - Procedural Geometry";

    const KEY_C = 67;
    const KEY_G = 71;
    const KEY_L = 76;
    const ACTION_PRESS = 1;

    // The sample's RaytracingSceneDefines.h and RaytracingHlslCompat.h.
    // max(sizeof(RayPayload) = float4 + uint, sizeof(ShadowRayPayload)).
    const PAYLOAD_SIZE = 20;
    // sizeof(ProceduralPrimitiveAttributes): float3 normal.
    const ATTRIBUTE_SIZE = 12;
    // MAX_RAY_RECURSION_DEPTH: primary rays + reflections + shadow rays from reflected geometry.
    const MAX_RECURSION_DEPTH = 3;
    const RAY_TYPE_COUNT = 2;

    // IntersectionShaderType: the hit group name part of each, and how many of the primitives
    // (AnalyticPrimitive: AABB, Spheres; VolumetricPrimitive: Metaballs; SignedDistancePrimitive:
    // MiniSpheres, IntersectedRoundCube, SquareTorus, TwistedTorus, Cog, Cylinder, FractalPyramid)
    // each intersects, in the order of the AABB geometries.
    const INTERSECTION_SHADER_NAMES = [
        "AnalyticPrimitive", "VolumetricPrimitive", "SignedDistancePrimitive",
    ];
    const PRIMITIVES_PER_INTERSECTION_SHADER = [2, 1, 7];
    // IntersectionShaderType::TotalPrimitiveCount.
    const PRIMITIVE_COUNT = 10;

    // The AABB geometries' indices (instanceIndex), AnalyticPrimitive first.
    const PRIM_AABB = 0;
    const PRIM_SPHERES = 1;
    const PRIM_METABALLS = 2;
    const PRIM_MINI_SPHERES = 3;
    const PRIM_INTERSECTED_ROUND_CUBE = 4;
    const PRIM_SQUARE_TORUS = 5;
    const PRIM_TWISTED_TORUS = 6;
    const PRIM_COG = 7;
    const PRIM_CYLINDER = 8;
    const PRIM_FRACTAL_PYRAMID = 9;

    // c_aabbWidth, c_aabbDistance.
    const AABB_WIDTH = 2.0;
    const AABB_DISTANCE = 2.0;

    // Each AABB's grid cell (BuildProceduralGeometryAABBs' offsetIndex) and size, by geometry index.
    const AABB_OFFSETS = [
        3.0, 0.0, 0.0,
        2.25, 0.0, 0.75,
        0.0, 0.0, 0.0,
        2.0, 0.0, 0.0,
        0.0, 0.0, 2.0,
        0.75, -0.1, 2.25,
        0.0, 0.0, 1.0,
        1.0, 0.0, 0.0,
        0.0, 0.0, 3.0,
        2.0, 0.0, 2.0,
    ];
    const AABB_SIZES = [
        2.0, 3.0, 2.0,
        3.0, 3.0, 3.0,
        3.0, 3.0, 3.0,
        2.0, 2.0, 2.0,
        2.0, 2.0, 2.0,
        3.0, 3.0, 3.0,
        2.0, 2.0, 2.0,
        2.0, 2.0, 2.0,
        2.0, 3.0, 2.0,
        6.0, 6.0, 6.0,
    ];
    // UpdateAABBPrimitiveAttributes: each AABB's scale (x, y, z) and whether it rotates.
    const AABB_SCALES = [
        1.0, 1.5, 1.0,
        1.5, 1.5, 1.5,
        1.5, 1.5, 1.5,
        1.0, 1.0, 1.0,
        1.0, 1.0, 1.0,
        1.5, 1.5, 1.5,
        1.0, 1.0, 1.0,
        1.0, 1.0, 1.0,
        1.0, 1.5, 1.0,
        3.0, 3.0, 3.0,
    ];
    // (1 if it rotates: an array of booleans read false in tslang.)
    const AABB_ROTATES = [0, 1, 1, 0, 0, 0, 1, 1, 0, 0];

    // InitializeScene's materials (PrimitiveConstantBuffer: albedo, reflectanceCoef, diffuseCoef,
    // specularCoef, specularPower, stepScale), the AABB geometries' then the plane's.
    const GREEN = [0.1, 1.0, 0.5, 1.0];
    const RED = [1.0, 0.5, 0.5, 1.0];
    const YELLOW = [1.0, 1.0, 0.5, 1.0];
    const CHROMIUM_REFLECTANCE = [0.549, 0.556, 0.554, 1.0];
    const PLANE_ALBEDO = [0.9, 0.9, 0.9, 1.0];
    // Floats per PrimitiveConstantBuffer (48 bytes, with its padding).
    const MATERIAL_FLOATS = 12;
    // Floats per PrimitiveInstancePerFrameBuffer: two float4x4.
    const AABB_ATTRIBUTE_FLOATS = 32;

    // BuildPlaneGeometry: a unit square on y = 0 (Vertex: position, normal), two triangles.
    const PLANE_VERTICES = [
        0.0, 0.0, 0.0, 0.0, 1.0, 0.0,
        1.0, 0.0, 0.0, 0.0, 1.0, 0.0,
        1.0, 0.0, 1.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 1.0, 0.0, 1.0, 0.0,
    ];
    const PLANE_INDICES = [3, 1, 0, 2, 1, 3];
    const VERTEX_STRIDE = 24;
    // sizeof(D3D12_RAYTRACING_AABB).
    const AABB_STRIDE = 24;

    // SceneConstantBuffer, padded to a constant buffer's 256 bytes.
    const SCENE_CB_SIZE = 256;

    // --- Passes -----------------------------------------------------------------------------

    // Port of DirectX-Graphics-Samples' D3D12RaytracingProceduralGeometry: a checkered plane (a
    // triangle BLAS) and ten AABBs (an AABB BLAS, one geometry each) whose analytic, volumetric
    // (metaballs) and signed distance (including a fractal pyramid) primitives three intersection
    // shaders find, with radiance and shadow rays (a hit group for each geometry and ray type),
    // reflections and Phong lighting. C, G and L toggle the camera's, the geometry's and the light's
    // animations.
    class ProceduralGeometryPass {
        private app: App;
        private bindingLayout: Opaque;
        private shaderTable: ShaderTable;
        private planeBlas: TriangleBlas;
        private aabbBlas: TriangleBlas;
        private topLevelAS: SceneAccelStructs;
        private topLevelASBuilt: boolean;
        // The BLAS builds' inputs; the plane's are also the closest hit shader's g_indices, g_vertices.
        private indexBuffer: BufferHandle;
        private vertexBuffer: BufferHandle;
        private aabbBuffer: BufferHandle;
        private sceneConstantBuffer: BufferHandle;
        private aabbAttributeBuffer: BufferHandle;
        private materialBuffer: BufferHandle;
        private aabbConstantBuffer: BufferHandle;
        // Created on the first frame (it has the frame's size), dropped on resize.
        private storageImage: Opaque | null;
        private bindingSet: BindingSet;
        private timerQuery: Opaque;
        private timerQueryInFlight: boolean;

        // The scene (InitializeScene): the AABBs' min x y z, max x y z; the camera; the light.
        private aabbs: f32[];
        private eye: number[];
        private at: number[];
        private up: number[];
        private lightPosition: number[];

        private sceneData: f32[];
        private aabbAttributes: f32[];

        private animateGeometryTime: number;
        private animateCamera: boolean;
        private animateGeometry: boolean;
        private animateLight: boolean;

        // CalculateFrameStats: frames and GPU time of DispatchRays over about a second.
        private statsSeconds: number;
        private statsFrames: int;
        private statsGpuSeconds: number;
        private statsGpuSamples: int;
        private titleInfo: string;
        // The last frame's size, for the rays per second.
        private lastWidth: int;
        private lastHeight: int;

        // -benchmark: 1/60 s per frame (for comparisons).
        benchmark: boolean;
        // -time <seconds>: the geometry animation's time, fixed.
        fixedTime: number;

        constructor(app: App) {
            this.app = app;
            this.topLevelASBuilt = false;
            this.storageImage = null;
            this.bindingSet = new BindingSet(null);
            this.timerQueryInFlight = false;
            this.aabbs = [];
            this.eye = [];
            this.at = [];
            this.up = [];
            this.lightPosition = [0.0, 18.0, -20.0, 0.0];
            this.sceneData = [];
            for (let i = 0; i < SCENE_CB_SIZE / 4; i++) {
                this.sceneData.push(0.0);
            }
            this.aabbAttributes = [];
            for (let i = 0; i < PRIMITIVE_COUNT * AABB_ATTRIBUTE_FLOATS; i++) {
                this.aabbAttributes.push(0.0);
            }
            this.animateGeometryTime = 0.0;
            this.animateCamera = false;
            this.animateGeometry = true;
            this.animateLight = false;
            this.statsSeconds = 0.0;
            this.statsFrames = 0;
            this.statsGpuSeconds = 0.0;
            this.statsGpuSamples = 0;
            this.titleInfo = "";
            this.lastWidth = 1;
            this.lastHeight = 1;
            this.benchmark = false;
            this.fixedTime = -1.0;
        }

        // The storage image has the back buffers' size.
        onBackBufferResizing(): void {
            const bindingSet = this.bindingSet;
            if (!bindingSet.isNull()) {
                this.app.releaseResource(bindingSet.handle);
                this.bindingSet = new BindingSet(null);
            }
            const storageImage = this.storageImage;
            if (storageImage) {
                this.app.releaseResource(storageImage);
                this.storageImage = null;
            }
        }

        onKey(key: int, scancode: int, action: int, mods: int): int {
            if (action == ACTION_PRESS) {
                if (key == KEY_C) {
                    this.animateCamera = !this.animateCamera;
                } else if (key == KEY_G) {
                    this.animateGeometry = !this.animateGeometry;
                } else if (key == KEY_L) {
                    this.animateLight = !this.animateLight;
                }
            }
            return 0;
        }

        // The sample's OnUpdate.
        onAnimate(elapsedSeconds: number): void {
            const elapsedSeconds32 = Math.fround(elapsedSeconds);
            const elapsedTime: number = this.benchmark ? Math.fround(1.0 / 60.0) : elapsedSeconds32;
            this.updateFrameStats(elapsedSeconds);

            // Rotate the camera around Y axis.
            if (this.animateCamera) {
                const secondsToRotateAround = 48.0;
                const angleToRotateBy = Math.fround(360.0 * Math.fround(elapsedTime / secondsToRotateAround));
                const rotate = matrixRotationY(radians(angleToRotateBy));
                this.eye = transform3(this.eye, rotate);
                this.up = transform3(this.up, rotate);
                this.at = transform3(this.at, rotate);
            }

            // Rotate the light around Y axis.
            if (this.animateLight) {
                const secondsToRotateAround = 8.0;
                const angleToRotateBy = Math.fround(-360.0 * Math.fround(elapsedTime / secondsToRotateAround));
                const rotate = matrixRotationY(radians(angleToRotateBy));
                this.lightPosition = transform3(this.lightPosition, rotate);
            }

            // Transform the procedural geometry.
            if (this.animateGeometry) {
                this.animateGeometryTime = Math.fround(this.animateGeometryTime + elapsedTime);
            }
            if (this.fixedTime >= 0.0) {
                this.animateGeometryTime = Math.fround(this.fixedTime);
            }
        }

        // CalculateFrameStats: the frame rate, DispatchRays' GPU time and the primary rays per
        // second, in the title once a second.
        updateFrameStats(elapsedSeconds: number): void {
            this.statsSeconds += elapsedSeconds;
            this.statsFrames++;
            if (this.statsSeconds >= 1.0) {
                const fps = this.statsFrames / this.statsSeconds;
                const raytracingMs: number = this.statsGpuSamples > 0 ? this.statsGpuSeconds / this.statsGpuSamples * 1000.0 : 0.0;
                const width = this.lastWidth;
                const height = this.lastHeight;
                // NumMRaysPerSecond: one primary ray per pixel.
                const mraysPerSecond: number = raytracingMs > 0.0 ? width * height / (raytracingMs * 1000.0) : 0.0;
                this.titleInfo = `    fps: ${fps.toFixed(2)}    DispatchRays(): ${raytracingMs.toFixed(2)}ms     ~Million Primary Rays/s: ${mraysPerSecond.toFixed(2)}`;
                this.statsSeconds = 0.0;
                this.statsFrames = 0;
                this.statsGpuSeconds = 0.0;
                this.statsGpuSamples = 0;
            }
            Donut_SetWindowTitle(this.app.handle, WINDOW_TITLE + this.titleInfo);
        }

        // UpdateCameraMatrices: projectionToWorld, the inverse of the view-projection matrix
        // (45 degrees vertically, depth 0.01 to 125), and the camera position.
        writeSceneConstants(width: int, height: int): void {
            const view = matrixLookAtLH(this.eye, this.at, this.up);
            const proj = matrixPerspectiveFovLH(radians(45.0), Math.fround(width / height), 0.01, 125.0);
            const projectionToWorld = matrixInverse(matrixMultiply(view, proj));
            for (let i = 0; i < 16; i++) {
                this.sceneData[i] = projectionToWorld[i];
            }
            for (let i = 0; i < 4; i++) {
                this.sceneData[16 + i] = this.eye[i];
                this.sceneData[20 + i] = this.lightPosition[i];
            }
            // lightAmbientColor, lightDiffuseColor.
            for (let i = 0; i < 3; i++) {
                this.sceneData[24 + i] = 0.25;
                this.sceneData[28 + i] = 0.6;
            }
            this.sceneData[27] = 1.0;
            this.sceneData[31] = 1.0;
            // reflectance (unused), elapsedTime.
            this.sceneData[32] = 0.0;
            this.sceneData[33] = this.animateGeometryTime;
        }

        // UpdateAABBPrimitiveAttributes: each AABB's local space (scaled, rotated about y by
        // -2 * animationTime, centered on the AABB) to the BLAS's space, and back.
        writeAabbAttributes(animationTime: number): void {
            const rotation = matrixRotationY(Math.fround(-2.0 * animationTime));
            const identity = matrixIdentity();
            for (let i = 0; i < PRIMITIVE_COUNT; i++) {
                const center = [
                    Math.fround(0.5 * Math.fround(this.aabbs[i * 6] + this.aabbs[i * 6 + 3])),
                    Math.fround(0.5 * Math.fround(this.aabbs[i * 6 + 1] + this.aabbs[i * 6 + 4])),
                    Math.fround(0.5 * Math.fround(this.aabbs[i * 6 + 2] + this.aabbs[i * 6 + 5])),
                ];
                const scale = matrixScaling(AABB_SCALES[i * 3], AABB_SCALES[i * 3 + 1], AABB_SCALES[i * 3 + 2]);
                let rotated = matrixMultiply(scale, identity);
                if (AABB_ROTATES[i] != 0) {
                    rotated = matrixMultiply(scale, rotation);
                }
                const transform = matrixMultiply(rotated, matrixTranslation(center[0], center[1], center[2]));
                const inverse = matrixInverse(transform);
                for (let j = 0; j < 16; j++) {
                    this.aabbAttributes[i * AABB_ATTRIBUTE_FLOATS + j] = transform[j];
                    this.aabbAttributes[i * AABB_ATTRIBUTE_FLOATS + 16 + j] = inverse[j];
                }
            }
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const commandList = frame.getCommandList();
            const width = frame.getWidth();
            const height = frame.getHeight();
            this.lastWidth = width;
            this.lastHeight = height;

            let storageImage = this.storageImage;
            let bindingSet = this.bindingSet;
            if (!storageImage || bindingSet.isNull()) {
                // The output the ray generation shader writes: UNORM, in the back buffer's channel
                // order, for the copy below.
                storageImage = this.app.createUAVTextureForFrameCopy(frame, "Output");

                const bindingSetDesc = BindingSetDesc.create();
                bindingSetDesc.bindAccelStruct(0, this.topLevelAS.getTopLevelAS());
                bindingSetDesc.bindTextureUAV(0, storageImage);
                bindingSetDesc.bindEntireConstantBuffer(0, this.sceneConstantBuffer);
                bindingSetDesc.bindStructuredBufferSRV(1, this.indexBuffer);
                bindingSetDesc.bindStructuredBufferSRV(2, this.vertexBuffer);
                bindingSetDesc.bindStructuredBufferSRV(3, this.aabbAttributeBuffer);
                bindingSetDesc.bindStructuredBufferSRV(4, this.materialBuffer);
                bindingSetDesc.bindStructuredBufferSRV(5, this.aabbConstantBuffer);
                bindingSet = this.app.createBindingSetForLayout(bindingSetDesc, this.bindingLayout);

                this.storageImage = storageImage;
                this.bindingSet = bindingSet;
            }

            // Its instances don't move: built once.
            if (!this.topLevelASBuilt) {
                frame.buildTopLevelAS(this.topLevelAS);
                this.topLevelASBuilt = true;
            }

            // The sample's DoRaytracing: the scene constants and the AABBs' transforms, then the rays.
            this.writeSceneConstants(width, height);
            this.writeAabbAttributes(this.animateGeometryTime);
            commandList.writeBuffer(this.sceneConstantBuffer, Ref(this.sceneData[0]), SCENE_CB_SIZE);
            commandList.writeBuffer(this.aabbAttributeBuffer, Ref(this.aabbAttributes[0]), this.aabbAttributes.length * 4);

            if (this.timerQueryInFlight && this.app.pollTimerQuery(this.timerQuery) != 0) {
                this.statsGpuSeconds += this.app.getTimerQueryTime(this.timerQuery);
                this.statsGpuSamples++;
                this.app.resetTimerQuery(this.timerQuery);
                this.timerQueryInFlight = false;
            }
            const measure = !this.timerQueryInFlight;
            if (measure) {
                commandList.beginTimerQuery(this.timerQuery);
            }
            frame.dispatchRays(this.shaderTable, bindingSet, width, height);
            if (measure) {
                commandList.endTimerQuery(this.timerQuery);
                this.timerQueryInFlight = true;
            }

            // CopyRaytracingOutputToBackbuffer: without conversion, as the sample's CopyResource
            // into its UNORM back buffer.
            frame.copyTextureToFrame(storageImage);
        }

        // BuildProceduralGeometryAABBs: the AABBs on a 4 x 1 x 4 grid of cells 4 apart, centered
        // on the origin, in float arithmetic as the sample's.
        buildAabbs(): void {
            const grid = [4.0, 1.0, 4.0];
            const stride = AABB_WIDTH + AABB_DISTANCE;
            for (let i = 0; i < PRIMITIVE_COUNT; i++) {
                for (let c = 0; c < 6; c++) {
                    const axis = c % 3;
                    const base = Math.fround(-(grid[axis] * AABB_WIDTH + (grid[axis] - 1.0) * AABB_DISTANCE) / 2.0);
                    const min = Math.fround(base + Math.fround(Math.fround(AABB_OFFSETS[i * 3 + axis]) * stride));
                    const value: number = c < 3 ? min : Math.fround(min + AABB_SIZES[i * 3 + axis]);
                    this.aabbs.push(value);
                }
            }
        }

        // InitializeScene's materials, the AABB geometries' (in geometry order) then the plane's,
        // and each AABB geometry's PrimitiveInstanceConstantBuffer.
        // A PrimitiveConstantBuffer (SetAttributes).
        addMaterial(materials: f32[], albedo: number[], reflectanceCoef: number, diffuseCoef: number,
            specularCoef: number, specularPower: number, stepScale: number): void {
            for (let i = 0; i < 4; i++) {
                materials.push(albedo[i]);
            }
            materials.push(reflectanceCoef);
            materials.push(diffuseCoef);
            materials.push(specularCoef);
            materials.push(specularPower);
            materials.push(stepScale);
            materials.push(0.0);
            materials.push(0.0);
            materials.push(0.0);
        }

        writeMaterials(commandList: CommandList): void {
            let materials: f32[] = [];
            // SetAttributes' defaults: reflectanceCoef 0, diffuseCoef 0.9, specularCoef 0.7,
            // specularPower 50, stepScale 1.
            this.addMaterial(materials, RED, 0.0, 0.9, 0.7, 50.0, 1.0);                     // AABB
            this.addMaterial(materials, CHROMIUM_REFLECTANCE, 1.0, 0.9, 0.7, 50.0, 1.0);    // Spheres
            this.addMaterial(materials, CHROMIUM_REFLECTANCE, 1.0, 0.9, 0.7, 50.0, 1.0);    // Metaballs
            this.addMaterial(materials, GREEN, 0.0, 0.9, 0.7, 50.0, 1.0);                   // MiniSpheres
            this.addMaterial(materials, GREEN, 0.0, 0.9, 0.7, 50.0, 1.0);                   // IntersectedRoundCube
            this.addMaterial(materials, CHROMIUM_REFLECTANCE, 1.0, 0.9, 0.7, 50.0, 1.0);    // SquareTorus
            this.addMaterial(materials, YELLOW, 0.0, 1.0, 0.7, 50.0, 0.5);                  // TwistedTorus
            this.addMaterial(materials, YELLOW, 0.0, 1.0, 0.1, 2.0, 1.0);                   // Cog
            this.addMaterial(materials, RED, 0.0, 0.9, 0.7, 50.0, 1.0);                     // Cylinder
            this.addMaterial(materials, GREEN, 0.0, 1.0, 0.1, 4.0, 0.8);                    // FractalPyramid
            this.addMaterial(materials, PLANE_ALBEDO, 0.25, 1.0, 0.4, 50.0, 1.0);           // the plane
            commandList.writeBuffer(this.materialBuffer, Ref(materials[0]), materials.length * 4);

            // BuildShaderTables' rootArgs.aabbCB: the AABB's index, and its primitive type within
            // its intersection shader's.
            let aabbConstants: int[] = [];
            let instanceIndex = 0;
            for (let shader = 0; shader < PRIMITIVES_PER_INTERSECTION_SHADER.length; shader++) {
                for (let primitive = 0; primitive < PRIMITIVES_PER_INTERSECTION_SHADER[shader]; primitive++) {
                    aabbConstants.push(instanceIndex);
                    aabbConstants.push(primitive);
                    instanceIndex++;
                }
            }
            commandList.writeBuffer(this.aabbConstantBuffer, Ref(aabbConstants[0]), aabbConstants.length * 4);
        }

        // BuildGeometry and BuildAccelerationStructures: the plane's BLAS, the AABBs' (one geometry
        // per AABB, for a hit group per AABB), and the TLAS's two instances.
        createAccelerationStructures(commandList: CommandList): boolean {
            let vertices: f32[] = [];
            for (let i = 0; i < PLANE_VERTICES.length; i++) {
                vertices.push(PLANE_VERTICES[i]);
            }
            let indices: int[] = [];
            for (let i = 0; i < PLANE_INDICES.length; i++) {
                indices.push(PLANE_INDICES[i]);
            }
            this.vertexBuffer = this.app.createAccelStructInputStructuredBuffer(4, vertices.length, "VertexBuffer");
            this.indexBuffer = this.app.createAccelStructInputStructuredBuffer(4, indices.length, "IndexBuffer");
            this.aabbBuffer = this.app.createAccelStructInputBuffer(PRIMITIVE_COUNT * AABB_STRIDE, "AABBBuffer");
            commandList.writeBuffer(this.vertexBuffer, Ref(vertices[0]), vertices.length * 4);
            commandList.writeBuffer(this.indexBuffer, Ref(indices[0]), indices.length * 4);
            commandList.writeBuffer(this.aabbBuffer, Ref(this.aabbs[0]), this.aabbs.length * 4);

            // Opaque geometries, built preferring fast tracing.
            const planeBlas = this.app.createEmptyTriangleBlas("PlaneBLAS");
            planeBlas.addGeometry(this.indexBuffer, 0, indices.length, this.vertexBuffer, 0, PLANE_VERTICES.length / 6,
                VERTEX_STRIDE, null);
            if (planeBlas.build(this.app, commandList, AccelStructBuildFlags.PreferFastTrace) == 0) {
                return false;
            }
            this.planeBlas = planeBlas;

            const aabbBlas = this.app.createEmptyTriangleBlas("AABBBLAS");
            for (let i = 0; i < PRIMITIVE_COUNT; i++) {
                aabbBlas.addAabbGeometry(this.aabbBuffer, i * AABB_STRIDE, 1, AABB_STRIDE);
            }
            if (aabbBlas.build(this.app, commandList, AccelStructBuildFlags.PreferFastTrace) == 0) {
                return false;
            }
            this.aabbBlas = aabbBlas;

            // BuildBotomLevelASInstanceDescs: the plane, a little larger than a 700 x 700 grid of
            // AABBs, from -0.35 of its width; the AABBs moved up onto it, their hit groups after the
            // plane's two.
            this.topLevelAS = this.app.createTopLevelASWithFlags(2, AccelStructBuildFlags.PreferFastTrace);
            if (this.topLevelAS.isNull()) {
                return false;
            }
            const planeWidthX = 700.0 * AABB_WIDTH + 699.0 * AABB_DISTANCE;
            const planeWidthY = 1.0 * AABB_WIDTH;
            const planeWidthZ = 700.0 * AABB_WIDTH + 699.0 * AABB_DISTANCE;
            let transform: f32[] = [
                planeWidthX, 0.0, 0.0, Math.fround(planeWidthX * Math.fround(-0.35)),
                0.0, planeWidthY, 0.0, 0.0,
                0.0, 0.0, planeWidthZ, Math.fround(planeWidthZ * Math.fround(-0.35)),
            ];
            this.topLevelAS.addInstanceWithHitGroup(planeBlas.getAccelStruct(), 1, 0, 0, 0, Ref(transform[0]));
            let aabbTransform: f32[] = [
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, AABB_WIDTH / 2.0,
                0.0, 0.0, 1.0, 0.0,
            ];
            this.topLevelAS.addInstanceWithHitGroup(aabbBlas.getAccelStruct(), 1, 0, RAY_TYPE_COUNT, 0, Ref(aabbTransform[0]));
            return true;
        }

        // CreateRaytracingPipelineStateObject and BuildShaderTables: the ray generation shader, the
        // radiance and shadow miss shaders, the plane's hit groups (a closest hit shader for
        // radiance rays, nothing for shadow rays: they skip closest hit shaders), and each
        // intersection shader's (with the AABB closest hit shader for radiance rays); in the hit
        // group table the plane's two, then each AABB's two.
        createRayTracingPipeline(): boolean {
            const shaderLibrary = this.app.createShaderLibrary("procedural_geometry.hlsl");
            if (!shaderLibrary) {
                return false;
            }
            const pipelineDesc = RtPipelineDesc.create(PAYLOAD_SIZE, MAX_RECURSION_DEPTH);
            pipelineDesc.setMaxAttributeSize(ATTRIBUTE_SIZE);
            pipelineDesc.addGlobalBindingLayout(this.bindingLayout);
            pipelineDesc.addShader(shaderLibrary, "MyRaygenShader", ShaderType.RayGeneration);
            pipelineDesc.addShader(shaderLibrary, "MyMissShader", ShaderType.Miss);
            pipelineDesc.addShader(shaderLibrary, "MyMissShader_ShadowRay", ShaderType.Miss);
            pipelineDesc.addHitGroup(shaderLibrary, "MyHitGroup_Triangle", "MyClosestHitShader_Triangle", "", null);
            pipelineDesc.addHitGroup(shaderLibrary, "MyHitGroup_Triangle_ShadowRay", "", "", null);
            for (let t = 0; t < INTERSECTION_SHADER_NAMES.length; t++) {
                const name = INTERSECTION_SHADER_NAMES[t];
                pipelineDesc.addProceduralHitGroup(shaderLibrary, `MyHitGroup_AABB_${name}`,
                    `MyIntersectionShader_${name}`, "MyClosestHitShader_AABB", "", null);
                pipelineDesc.addProceduralHitGroup(shaderLibrary, `MyHitGroup_AABB_${name}_ShadowRay`,
                    `MyIntersectionShader_${name}`, "", "", null);
            }
            const pipeline = this.app.createRayTracingPipelineFromDesc(pipelineDesc);
            if (!pipeline) {
                return false;
            }

            const shaderTable = this.app.createEmptyShaderTable(pipeline);
            // The shader table keeps the pipeline alive.
            this.app.releaseResource(pipeline);
            shaderTable.setRayGeneration("MyRaygenShader");
            shaderTable.addMiss("MyMissShader");
            shaderTable.addMiss("MyMissShader_ShadowRay");
            shaderTable.addHitGroup("MyHitGroup_Triangle", null);
            shaderTable.addHitGroup("MyHitGroup_Triangle_ShadowRay", null);
            for (let t = 0; t < INTERSECTION_SHADER_NAMES.length; t++) {
                const name = INTERSECTION_SHADER_NAMES[t];
                for (let primitive = 0; primitive < PRIMITIVES_PER_INTERSECTION_SHADER[t]; primitive++) {
                    shaderTable.addHitGroup(`MyHitGroup_AABB_${name}`, null);
                    shaderTable.addHitGroup(`MyHitGroup_AABB_${name}_ShadowRay`, null);
                }
            }
            this.shaderTable = shaderTable;
            return true;
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            // CreateRootSignatures' global root signature; the local ones' constants are in t4, t5.
            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutAccelStruct(0);
            layoutDesc.layoutTextureUAV(0);
            layoutDesc.layoutVolatileConstantBuffer(0);
            for (let slot = 1; slot <= 5; slot++) {
                layoutDesc.layoutStructuredBufferSRV(slot);
            }
            this.bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.All);

            if (!this.createRayTracingPipeline()) {
                return false;
            }

            // InitializeScene's camera: from (0, 5.3, -17) towards the origin, its up vector
            // perpendicular to the view direction and x, both turned 45 degrees about y.
            this.eye = [0.0, Math.fround(5.3), -17.0, 1.0];
            this.at = [0.0, 0.0, 0.0, 1.0];
            const direction = normalize4(vsub(this.at, this.eye));
            this.up = normalize3(cross3(direction, [1.0, 0.0, 0.0, 0.0]));
            const rotate = matrixRotationY(radians(45.0));
            this.eye = transform3(this.eye, rotate);
            this.up = transform3(this.up, rotate);

            this.buildAabbs();

            this.sceneConstantBuffer = this.app.createVolatileConstantBuffer(SCENE_CB_SIZE, "SceneConstants");
            this.aabbAttributeBuffer = this.app.createStructuredBuffer(AABB_ATTRIBUTE_FLOATS * 4, PRIMITIVE_COUNT, "AABBPrimitiveAttributes");
            this.materialBuffer = this.app.createStructuredBuffer(MATERIAL_FLOATS * 4, PRIMITIVE_COUNT + 1, "Materials");
            this.aabbConstantBuffer = this.app.createStructuredBuffer(8, PRIMITIVE_COUNT, "AABBConstants");
            this.timerQuery = this.app.createTimerQuery();

            const commandList = this.app.createCommandList();
            commandList.open();
            this.writeMaterials(commandList);
            const created = this.createAccelerationStructures(commandList);
            commandList.close();
            this.app.executeCommandList(commandList);
            // The AABBs are only needed for the build: the command list references them, and the app
            // holds it until the GPU is done with it.
            this.app.releaseResource(this.aabbBuffer);
            this.app.releaseResource(commandList.handle);
            if (!created) {
                return false;
            }

            const pass = this.app.addPass();
            pass.setAnimateCallback(this.onAnimate);
            pass.setKeyboardCallback(this.onKey);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("procedural_geometry");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -benchmark: 1/60 s per frame.
        // -time <seconds>: the geometry animation's time, fixed.
        let options = AppOptions.RayTracing;
        let benchmark = false;
        let fixedTime = -1.0;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = options | AppOptions.DebugRuntime;
            } else if (arg == "-benchmark") {
                benchmark = true;
            } else if (arg == "-time" && i + 1 < argc) {
                i++;
                fixedTime = parseFloat(Donut_GetArg(argv, i));
            }
        }

        // The sample's window.
        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        if (!app.isFeatureSupported(Feature.RayTracingPipeline)) {
            console.log("The graphics device does not support Ray Tracing Pipelines");
            app.destroy();
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const pass = new ProceduralGeometryPass(app);
        pass.benchmark = benchmark;
        pass.fixedTime = fixedTime;
        if (!pass.init()) {
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
    return ProceduralGeometry.main(argc, argv);
}

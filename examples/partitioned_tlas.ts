// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, unsupported } from "../core/test_check";
import { Ptlas } from "../core/ptlas";
import { matrixInverse, matrixLookAtRH, matrixMultiply, matrixPerspectiveFovRH, radians } from "../core/directx_math";
import { formatFixed } from "../core/text_format";

namespace PartitionedTlas {
    const WINDOW_TITLE = "Partitioned TLAS";

    // The sample's default scene: a 16 x 16 grid of dominoes 1.3 apart, in 4 x 4 partitions of 4 x 4
    // dominoes (its --axis 16 --partitions 4), no static scenery (--static-count 0).
    const DOMINOES_PER_AXIS = 16;
    const PARTITIONS_PER_AXIS = 4;
    const DOMINO_COUNT = DOMINOES_PER_AXIS * DOMINOES_PER_AXIS;
    const PARTITION_COUNT = PARTITIONS_PER_AXIS * PARTITIONS_PER_AXIS;
    const MAX_INSTANCES_PER_PARTITION = (DOMINOES_PER_AXIS / PARTITIONS_PER_AXIS) * (DOMINOES_PER_AXIS / PARTITIONS_PER_AXIS);
    const DOMINO_SPACING = 1.3;

    // D3D12_RAYTRACING_INSTANCE_DESC / VkAccelerationStructureInstanceKHR, the instance-write arguments,
    // RaytracingHlslCompat.h's Motion, FrameConstants and AnimationConstants, in bytes.
    const REGULAR_INSTANCE_SIZE = 64;
    const WRITE_INSTANCE_SIZE = 104;
    const MOTION_SIZE = 96;
    const FRAME_CONSTANTS_SIZE = 144;
    const ANIMATION_CONSTANTS_SIZE = 76;
    // sizeof(RayPayload); the reflection / refraction path's depth (CreateRaytracingPipelineStateObject).
    const PAYLOAD_SIZE = 56;
    const ATTRIBUTE_SIZE = 8;
    const MAX_RECURSION_DEPTH = 10;
    // The ID that marks an instance as static scenery (none here) and the global partition.
    const GLOBAL_PARTITION = -1;
    const GROUP_SIZE = 256;
    const COMPOSITE_GROUP_SIZE = 16;
    // Donut_CreatePtlas's flags: the hints, and an updatable reference TLAS (the regular TLAS here).
    const PTLAS_FAST_TRACE = 1;
    const PTLAS_FAST_BUILD = 2;
    const PTLAS_UPDATABLE_REFERENCE_TLAS = 8;
    // Readbacks and GPU timers in flight: the frame that reads one waits for the GPU at most rarely.
    const FRAMES_IN_FLIGHT = 4;

    // Test mode: the frames rendered (the sample's --frames 120: the seeded domino falling into the
    // next ones).
    const TEST_FRAMES = 120;

    // The update modes (1, 2, 3 keys): moving dominoes update their partition, move to the global
    // partition, or only the far ones do.
    const MODE_NAMES = ["update partition", "move to global", "near update / far global"];

    // f32 arrays with uint fields (RawMemory.storeInt32 writes their bits).
    function storeUint(array: f32[], index: int, value: int) {
        RawMemory.storeInt32(Ref(array[index]), value);
    }

    // SceneMath.h's float math.
    function length3(v: number[]): number {
        const x = Math.fround(v[0] * v[0]);
        const y = Math.fround(v[1] * v[1]);
        const z = Math.fround(v[2] * v[2]);
        return Math.fround(Math.sqrt(Math.fround(Math.fround(x + y) + z)));
    }

    function normalize3(v: number[]): number[] {
        const scale = Math.fround(1.0 / length3(v));
        return [Math.fround(v[0] * scale), Math.fround(v[1] * scale), Math.fround(v[2] * scale)];
    }

    function cross3(a: number[], b: number[]): number[] {
        return [
            Math.fround(Math.fround(a[1] * b[2]) - Math.fround(b[1] * a[2])),
            Math.fround(Math.fround(a[2] * b[0]) - Math.fround(b[2] * a[0])),
            Math.fround(Math.fround(a[0] * b[1]) - Math.fround(b[0] * a[1])),
        ];
    }

    // scene_meshes::cube(): 4 vertices and 2 triangles a face, the face's normal at its vertices.
    class CubeMesh {
        positions: f32[] = [];
        normals: number[] = [];
        indices: int[] = [];

        constructor() {
            const s = 0.5;
            const p = [
                -s, -s, -s, -s, -s, s, -s, s, -s, -s, s, s,
                s, -s, -s, s, -s, s, s, s, -s, s, s, s,
            ];
            const n = [-1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, -1.0, 0.0, 0.0, 1.0, 0.0];
            const faces = [0, 1, 3, 2, 1, 5, 7, 3, 5, 4, 6, 7, 4, 0, 2, 6, 4, 5, 1, 0, 2, 3, 7, 6];
            for (let face = 0; face < 6; face++) {
                const first = this.positions.length / 3;
                for (let corner = 0; corner < 4; corner++) {
                    const vertex = faces[face * 4 + corner];
                    for (let c = 0; c < 3; c++) {
                        this.positions.push(p[vertex * 3 + c]);
                        this.normals.push(n[face * 3 + c]);
                    }
                }
                this.indices.push(first);
                this.indices.push(first + 1);
                this.indices.push(first + 2);
                this.indices.push(first);
                this.indices.push(first + 2);
                this.indices.push(first + 3);
            }
        }

        // BuildGeometryAndBLAS's triangle data: per triangle its first vertex's normal and two edges.
        triangleData(): f32[] {
            const data: f32[] = [];
            for (let t = 0; t < this.indices.length; t += 3) {
                const a = this.indices[t];
                const b = this.indices[t + 1];
                const c = this.indices[t + 2];
                for (let k = 0; k < 3; k++) {
                    data.push(this.normals[a * 3 + k]);
                }
                for (let k = 0; k < 3; k++) {
                    data.push(Math.fround(this.positions[b * 3 + k] - this.positions[a * 3 + k]));
                }
                for (let k = 0; k < 3; k++) {
                    data.push(Math.fround(this.positions[c * 3 + k] - this.positions[a * 3 + k]));
                }
            }
            return data;
        }
    }

    class Settings {
        usePtlas = true;
        updateMode: int = 0;
        showPartitionColors = true;
        paused = false;
        markAllInPartition = false;
        tlasRefit = true;
        selfToppleCount: int = 1;
        renderScale: int = 2;
        ptlasFlags: int = 0;
        // The instance-write arguments' layout is the API's.
        api: GraphicsAPI = GraphicsAPI.D3D12;
        // -stateDump <file> (the sample's --state-dump; with -test): the last frame's physics state
        // (256 Motion records), for comparing runs.
        stateDumpPath = "";
        // -image <file> (the sample's --image; with -test): the last frame's composited image at the
        // render resolution, raw RGBA8 rows (BGRA on Vulkan at render scale 1).
        imagePath = "";
        stateDumpFrame: int = -1;
    }

    // Port of DirectX-Graphics-Samples' D3D12RaytracingPartitionedTLAS (NVIDIA's D3D12 port of
    // vk_partitioned_tlas), its default scene: a grid of 256 dominoes in 16 partitions, the last one
    // pushed over at start. Each frame a compute shader advances their rigid-body physics (five
    // substeps, each domino against its two neighbors on the path), another marks the partitions
    // that moved, and a third appends a PTLAS instance write for each domino that moved or changed
    // partition - counting them on the GPU, so the indirect PTLAS update reads a count the CPU never
    // sees - or (P) writes every instance of a regular TLAS that is refitted (T: rebuilt) instead.
    // The update modes (1-3) keep moving dominoes in their partitions, move them to the global one,
    // or only the far ones. The ray generation shader traces the PTLAS (GGX sun light, shadows and
    // ambient occlusion by ray queries, reflections and refraction by recursive rays, up to 10
    // deep), coloring dominoes by partition (C) and red just after a hit; four compute passes
    // composite the result into a sketch style (AO smoothing, edges, a median filter), rendered at
    // twice the window's resolution and averaged down (-renderScale 1: at the window's).
    // F pauses, N steps, R resets the motion; WASD / QE move, a left drag looks around, a right
    // click topples the domino under the cursor.
    class PartitionedTlasPass {
        private app: App;
        private ptlas: Ptlas;
        private settings: Settings;
        private dominoBlas: TriangleBlas;
        private inputBuffers: BufferHandle[];

        private originalRegular: BufferHandle;
        private originalPartitioned: BufferHandle;
        private seedVelocities: BufferHandle;
        private physicsState: BufferHandle[];
        private instancePartitions: BufferHandle;
        private partitionActivity: BufferHandle;
        private triangleData: BufferHandle;
        private pickResult: BufferHandle;
        private unusedBuffer: BufferHandle;
        private frameConstants: BufferHandle;

        private animationLayout: BindingLayoutHandle;
        private simulatePipeline: ComputePipelineHandle;
        private markPartitionsPipeline: ComputePipelineHandle;
        private animatePipeline: ComputePipelineHandle;
        // By the physics buffer the frame starts from.
        private simulateSets: BindingSet[];
        private markPartitionsSets: BindingSet[];
        private animateSets: BindingSet[];

        // The ray tracing pipeline over the PTLAS and over the regular TLAS (their binding layouts
        // differ in t0's descriptor type on Vulkan).
        private rayTracingLayouts: BindingLayoutHandle[];
        private shaderTables: ShaderTable[];
        private compositeLayout: BindingLayoutHandle;
        private compositePipeline: ComputePipelineHandle;

        // Created on the first frame (they have its size), dropped on resize: the trace images, the
        // composited image and the image copied to the frame (the same at render scale 1).
        private traceImages: TextureHandle[];
        private renderOutput: TextureHandle | null;
        private displayOutput: TextureHandle | null;
        // [ptlas ? 0 : 1][physics buffer].
        private rayTracingSets: BindingSet[];
        private compositeSet: BindingSet;

        private readbacks: BufferHandle[];
        private readbackPending: boolean[];
        private readbackPtlas: boolean[];
        private readbackPick: boolean[];
        private readbackFrame: int[];
        private updateTimers: TimerQueryHandle[];
        private traceTimers: TimerQueryHandle[];
        private timerPending: boolean[];

        // The simulation.
        private frameIndex: int;
        private physicsCurrentIndex: int;
        private physicsResetPending: boolean;
        private ptlasNeedsSync: boolean;
        private tlasNeedsSync: boolean;
        private step: boolean;
        private reset: boolean;
        private manualTopple: boolean;
        private toppleIndex: int;

        // The camera.
        private cameraEye: number[];
        private cameraYaw: number;
        private cameraPitch: number;
        private keysDown: boolean[];
        private dragging: boolean;
        private mouseX: number;
        private mouseY: number;
        private pickRequested: boolean;
        private pickX: number;
        private pickY: number;
        private elapsed: number;

        // The stats the title shows.
        private fps: number;
        lastChangedCount: int;
        // -test: the write counts read back, by frame (-1 where not read or not with the PTLAS).
        writeCounts: int[];
        gpuUpdateMs: number;
        gpuTraceMs: number;

        // -stateDump's copy of the physics state.
        stateDump: BufferHandle | null;
        private frameData: f32[];
        private animationData: f32[];
        private compositeData: int[];

        constructor(app: App, ptlas: Ptlas, settings: Settings) {
            this.app = app;
            this.ptlas = ptlas;
            this.settings = settings;
            this.inputBuffers = [];
            this.physicsState = [];
            this.simulateSets = [];
            this.markPartitionsSets = [];
            this.animateSets = [];
            this.rayTracingLayouts = [];
            this.shaderTables = [];
            this.traceImages = [];
            this.renderOutput = null;
            this.displayOutput = null;
            this.rayTracingSets = [];
            this.compositeSet = new BindingSet(null);
            this.readbacks = [];
            this.readbackPending = [];
            this.readbackPtlas = [];
            this.readbackPick = [];
            this.readbackFrame = [];
            this.updateTimers = [];
            this.traceTimers = [];
            this.timerPending = [];
            this.frameIndex = 0;
            this.physicsCurrentIndex = 0;
            this.physicsResetPending = true;
            this.ptlasNeedsSync = true;
            this.tlasNeedsSync = true;
            this.step = false;
            this.reset = false;
            this.manualTopple = false;
            this.toppleIndex = 0;
            this.cameraEye = [0.0, 16.0, -28.0];
            this.cameraYaw = 0.0;
            this.cameraPitch = 0.0;
            this.keysDown = [];
            for (let i = 0; i < 512; i++) {
                this.keysDown.push(false);
            }
            this.dragging = false;
            this.mouseX = 0.0;
            this.mouseY = 0.0;
            this.pickRequested = false;
            this.pickX = 0.0;
            this.pickY = 0.0;
            this.elapsed = 0.0;
            this.fps = 0.0;
            this.lastChangedCount = 0;
            this.writeCounts = [];
            this.gpuUpdateMs = 0.0;
            this.gpuTraceMs = 0.0;
            this.stateDump = null;
            this.frameData = [];
            for (let i = 0; i < FRAME_CONSTANTS_SIZE / 4; i++) {
                this.frameData.push(0.0);
            }
            this.animationData = [];
            for (let i = 0; i < ANIMATION_CONSTANTS_SIZE / 4; i++) {
                this.animationData.push(0.0);
            }
            this.compositeData = [0];
        }

        init() {
            // CreateFrameConstants' camera: from (0, 16, -28) towards the origin, as a yaw and pitch.
            const forward = normalize3([-this.cameraEye[0], -this.cameraEye[1], -this.cameraEye[2]]);
            this.cameraYaw = Math.fround(Math.atan2(forward[0], forward[2]));
            this.cameraPitch = Math.fround(Math.asin(forward[1]));

            this.createBuffers();
            const commandList = this.app.createCommandList();
            commandList.open();
            const created = this.createScene(commandList);
            commandList.close();
            this.app.executeCommandList(commandList);
            // Only needed for the builds: the command list references them, and the app holds it until
            // the GPU is done with it.
            for (const inputBuffer of this.inputBuffers) {
                this.app.releaseResource(inputBuffer);
            }
            this.app.releaseResource(commandList.handle);
            if (!created || !this.createAnimationPipelines() || !this.createRayTracingPipelines()
                || !this.createCompositingPipeline()) {
                return false;
            }

            for (let i = 0; i < FRAMES_IN_FLIGHT; i++) {
                this.readbacks.push(this.app.createReadbackBuffer(8, "Write count and pick readback"));
                this.readbackPending.push(false);
                this.readbackPtlas.push(false);
                this.readbackPick.push(false);
                this.readbackFrame.push(0);
                this.updateTimers.push(this.app.createTimerQuery());
                this.traceTimers.push(this.app.createTimerQuery());
                this.timerPending.push(false);
            }

            const pass = this.app.addPass();
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            pass.setKeyboardCallback(this.onKey);
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            return true;
        }

        createBuffers() {
            this.originalRegular = this.app.createRawBuffer(DOMINO_COUNT * REGULAR_INSTANCE_SIZE, "Original regular instances");
            this.originalPartitioned = this.app.createRawBuffer(DOMINO_COUNT * WRITE_INSTANCE_SIZE, "Original partitioned instances");
            this.seedVelocities = this.app.createRawBuffer(16, "Seed angular velocities");
            for (let i = 0; i < 2; i++) {
                this.physicsState.push(this.app.createRawBuffer(DOMINO_COUNT * MOTION_SIZE, `Physics state ${i}`));
            }
            this.instancePartitions = this.app.createRawBuffer(DOMINO_COUNT * 4, "Instance partition IDs");
            this.partitionActivity = this.app.createRawBuffer(PARTITION_COUNT * 4, "Partition activity");
            this.triangleData = this.app.createRawBuffer(12 * 36, "Triangle data");
            this.pickResult = this.app.createRawBuffer(4, "Pick result");
            // Bound where a shader declares a buffer it doesn't use (a buffer can't be read and
            // written through the same binding set).
            this.unusedBuffer = this.app.createRawBuffer(16, "Unused");
            this.frameConstants = this.app.createConstantBuffer(256, "Frame constants");
        }

        // BuildGeometryAndBLAS (the domino's BLAS: the unit cube, scaled by its instances) and
        // CreateSceneAndTopLevels: the dominoes' instances, the regular TLAS and the PTLAS built from
        // them, the seed's angular velocity, and the buffers the shaders start from.
        createScene(commandList: CommandList) {
            const cube = new CubeMesh();
            const vertexBuffer = this.app.createAccelStructInputBuffer(cube.positions.length * 4, "Domino vertices");
            const indexBuffer = this.app.createAccelStructInputBuffer(cube.indices.length * 4, "Domino indices");
            commandList.writeBuffer(vertexBuffer, Ref(cube.positions[0]), cube.positions.length * 4);
            commandList.writeBuffer(indexBuffer, Ref(cube.indices[0]), cube.indices.length * 4);
            this.inputBuffers.push(vertexBuffer);
            this.inputBuffers.push(indexBuffer);
            const blas = this.app.createEmptyTriangleBlas("Domino BLAS");
            blas.addGeometry(indexBuffer, 0, cube.indices.length, vertexBuffer, 0, cube.positions.length / 3, 12, null);
            if (blas.build(this.app, commandList, AccelStructBuildFlags.PreferFastTrace) == 0) {
                return false;
            }
            this.dominoBlas = blas;
            const triangles = cube.triangleData();
            commandList.writeBuffer(this.triangleData, Ref(triangles[0]), triangles.length * 4);

            const blasAddress: int[] = [0, 0];
            this.ptlas.storeAccelStructAddress(blas.getAccelStruct(), Ref(blasAddress[0]));
            const vulkan = this.settings.api == GraphicsAPI.VULKAN;

            // The instances: a domino 0.35 x 2 x 0.18 standing at y = 1, facing -z (its scale's
            // negative x and z turn it about y), InstanceID its index.
            const regular: f32[] = [];
            for (let i = 0; i < DOMINO_COUNT * REGULAR_INSTANCE_SIZE / 4; i++) {
                regular.push(0.0);
            }
            const partitioned: f32[] = [];
            for (let i = 0; i < DOMINO_COUNT * WRITE_INSTANCE_SIZE / 4; i++) {
                partitioned.push(0.0);
            }
            const half = Math.fround((DOMINOES_PER_AXIS - 1) * 0.5);
            const spacing = Math.fround(DOMINO_SPACING);
            for (let index = 0; index < DOMINO_COUNT; index++) {
                const x = index % DOMINOES_PER_AXIS;
                const z = Math.floor(index / DOMINOES_PER_AXIS);
                const worldX = Math.fround(Math.fround(x - half) * spacing);
                const worldZ = Math.fround(Math.fround(z - half) * spacing);
                const transform = [
                    Math.fround(-0.35), 0.0, 0.0, worldX,
                    0.0, 2.0, 0.0, 1.0,
                    0.0, 0.0, Math.fround(-0.18), worldZ,
                ];
                const partition = Math.floor(x * PARTITIONS_PER_AXIS / DOMINOES_PER_AXIS)
                    + PARTITIONS_PER_AXIS * Math.floor(z * PARTITIONS_PER_AXIS / DOMINOES_PER_AXIS);

                // InstanceID (24 bits), InstanceMask 0xff; hit group 0, flags 0; the BLAS.
                const r = index * REGULAR_INSTANCE_SIZE / 4;
                for (let k = 0; k < 12; k++) {
                    regular[r + k] = transform[k];
                }
                storeUint(regular, r + 12, index | (0xff << 24));
                storeUint(regular, r + 14, blasAddress[0]);
                storeUint(regular, r + 15, blasAddress[1]);

                const p = index * WRITE_INSTANCE_SIZE / 4;
                for (let k = 0; k < 12; k++) {
                    partitioned[p + k] = transform[k];
                }
                if (vulkan) {
                    // transform, explicitAABB[6], instanceID, instanceMask,
                    // instanceContributionToHitGroupIndex, instanceFlags, instanceIndex,
                    // partitionIndex, accelerationStructure.
                    storeUint(partitioned, p + 18, index);
                    storeUint(partitioned, p + 19, 0xff);
                    storeUint(partitioned, p + 22, index);
                    storeUint(partitioned, p + 23, partition);
                    storeUint(partitioned, p + 24, blasAddress[0]);
                    storeUint(partitioned, p + 25, blasAddress[1]);
                } else {
                    // Transform, InstanceID, InstanceMask, InstanceContributionToHitGroupIndex,
                    // InstanceFlags, AccelerationStructure, InstanceIndex, PartitionIndex,
                    // ExplicitAABB.
                    storeUint(partitioned, p + 12, index);
                    storeUint(partitioned, p + 13, 0xff);
                    storeUint(partitioned, p + 16, blasAddress[0]);
                    storeUint(partitioned, p + 17, blasAddress[1]);
                    storeUint(partitioned, p + 18, index);
                    storeUint(partitioned, p + 19, partition);
                }
            }
            commandList.writeBuffer(this.originalRegular, Ref(regular[0]), regular.length * 4);
            commandList.writeBuffer(this.originalPartitioned, Ref(partitioned[0]), partitioned.length * 4);

            // CreateRegularTLAS: built from the instances (allowing updates), which the animation
            // shader rewrites in place while the regular TLAS is selected.
            commandList.writeBuffer(this.ptlas.getReferenceInstances(), Ref(regular[0]), regular.length * 4);
            this.ptlas.buildReferenceTlas(commandList.handle, DOMINO_COUNT);
            // CreatePartitionedTLAS: every instance written into its partition.
            commandList.writeBuffer(this.ptlas.getWriteInstanceArgs(), Ref(partitioned[0]), partitioned.length * 4);
            this.ptlas.build(commandList.handle, DOMINO_COUNT, 0, 0);

            // UploadSeedVelocities: the last domino's angular velocity, toppling it away from the
            // previous one (-x), about z.
            const seed: f32[] = [0.0, 0.0, 0.0, 0.0];
            if (this.settings.selfToppleCount != 0) {
                const last = (DOMINO_COUNT - 1) * REGULAR_INSTANCE_SIZE / 4;
                const previous = (DOMINO_COUNT - 2) * REGULAR_INSTANCE_SIZE / 4;
                const delta = [
                    Math.fround(regular[last + 3] - regular[previous + 3]),
                    Math.fround(regular[last + 7] - regular[previous + 7]),
                    Math.fround(regular[last + 11] - regular[previous + 11]),
                ];
                const direction = normalize3(delta);
                const orientation = [-direction[0], -direction[1], -direction[2]];
                const axis = normalize3(cross3([0.0, 1.0, 0.0], orientation));
                for (let k = 0; k < 3; k++) {
                    seed[k] = Math.fround(-axis[k] * Math.fround(5.5));
                }
            }
            commandList.writeBuffer(this.seedVelocities, Ref(seed[0]), 16);

            // CreateAnimationResources: no partition active yet, no pick.
            const zeros: int[] = [];
            for (let i = 0; i < PARTITION_COUNT; i++) {
                zeros.push(0);
            }
            commandList.writeBuffer(this.partitionActivity, Ref(zeros[0]), PARTITION_COUNT * 4);
            const noPick: int[] = [-1];
            commandList.writeBuffer(this.pickResult, Ref(noPick[0]), 4);
            return true;
        }

        // CreateAnimationPipelines: Simulate, MarkPartitions and Animate over one binding layout (the
        // sample's root signature); a binding set each per physics buffer the frame starts from.
        createAnimationPipelines() {
            const layoutDesc = BindingLayoutDesc.create();
            for (let t = 0; t < 5; t++) {
                layoutDesc.layoutRawBufferSRV(t);
            }
            for (let u = 0; u < 6; u++) {
                layoutDesc.layoutRawBufferUAV(u);
            }
            layoutDesc.layoutPushConstants(0, ANIMATION_CONSTANTS_SIZE);
            this.animationLayout = this.app.createBindingLayout(layoutDesc, ShaderType.Compute);

            const names = ["Simulate", "MarkPartitions", "Animate"];
            const pipelines: ComputePipelineHandle[] = [];
            for (const name of names) {
                const shader = this.app.createShader("partitioned_tlas/animation.hlsl", name, ShaderType.Compute);
                if (!shader) {
                    return false;
                }
                pipelines.push(this.app.createComputePipelineWithLayout(shader, this.animationLayout));
                this.app.releaseResource(shader);
            }
            this.simulatePipeline = pipelines[0];
            this.markPartitionsPipeline = pipelines[1];
            this.animatePipeline = pipelines[2];

            for (let current = 0; current < 2; current++) {
                const previous = this.physicsState[current];
                const next = this.physicsState[1 - current];
                // Simulate: previous -> next.
                this.simulateSets.push(this.createAnimationSet(previous, this.seedVelocities, next, this.unusedBuffer));
                // MarkPartitions: next -> the partitions' activity.
                this.markPartitionsSets.push(this.createAnimationSet(next, this.seedVelocities, this.unusedBuffer, this.partitionActivity));
                // Animate: next and the activity -> the instances.
                this.animateSets.push(this.createAnimationSet(next, this.partitionActivity, this.unusedBuffer, this.unusedBuffer));
            }
            return true;
        }

        // A binding set of the animation layout: t2, t3, u4 and u5 as given.
        createAnimationSet(physicsPrevious: BufferHandle, partitionActivity: BufferHandle, physicsCurrent: BufferHandle,
            partitionActivityOutput: BufferHandle): BindingSet {
            const desc = BindingSetDesc.create();
            desc.bindRawBufferSRV(0, this.originalRegular);
            desc.bindRawBufferSRV(1, this.originalPartitioned);
            desc.bindRawBufferSRV(2, physicsPrevious);
            desc.bindRawBufferSRV(3, partitionActivity);
            desc.bindRawBufferSRV(4, this.seedVelocities);
            desc.bindRawBufferUAV(0, this.ptlas.getReferenceInstances());
            desc.bindRawBufferUAV(1, this.ptlas.getWriteInstanceArgs());
            desc.bindRawBufferUAV(2, this.ptlas.getOperations());
            desc.bindRawBufferUAV(3, this.instancePartitions);
            desc.bindRawBufferUAV(4, physicsCurrent);
            desc.bindRawBufferUAV(5, partitionActivityOutput);
            desc.bindPushConstants(0, ANIMATION_CONSTANTS_SIZE);
            return this.app.createBindingSetForLayout(desc, this.animationLayout);
        }

        // CreateRaytracingPipelineStateObject: RayGen, Miss, and the hit group of ClosestHit; t0 the
        // PTLAS or the regular TLAS.
        createRayTracingPipelines() {
            const shaderLibrary = this.app.createShaderLibrary("partitioned_tlas/raytracing.hlsl");
            if (!shaderLibrary) {
                return false;
            }
            for (let regular = 0; regular < 2; regular++) {
                const layoutDesc = BindingLayoutDesc.create();
                if (regular == 0) {
                    layoutDesc.layoutPartitionedAccelStruct(0);
                } else {
                    layoutDesc.layoutAccelStruct(0);
                }
                for (let t = 1; t < 5; t++) {
                    layoutDesc.layoutRawBufferSRV(t);
                }
                for (let u = 0; u < 3; u++) {
                    layoutDesc.layoutTextureUAV(u);
                }
                layoutDesc.layoutRawBufferUAV(3);
                layoutDesc.layoutConstantBuffer(0);
                const layout = this.app.createBindingLayout(layoutDesc, ShaderType.All);
                this.rayTracingLayouts.push(layout);

                const pipelineDesc = RtPipelineDesc.create(PAYLOAD_SIZE, MAX_RECURSION_DEPTH);
                pipelineDesc.setMaxAttributeSize(ATTRIBUTE_SIZE);
                pipelineDesc.addGlobalBindingLayout(layout);
                pipelineDesc.addShader(shaderLibrary, "RayGen", ShaderType.RayGeneration);
                pipelineDesc.addShader(shaderLibrary, "Miss", ShaderType.Miss);
                pipelineDesc.addHitGroup(shaderLibrary, "HitGroup", "ClosestHit", "", null);
                const pipeline = this.app.createRayTracingPipelineFromDesc(pipelineDesc);
                if (!pipeline) {
                    return false;
                }
                const shaderTable = this.app.createEmptyShaderTable(pipeline);
                // The shader table keeps the pipeline alive.
                this.app.releaseResource(pipeline);
                shaderTable.setRayGeneration("RayGen");
                shaderTable.addMiss("Miss");
                shaderTable.addHitGroup("HitGroup", null);
                this.shaderTables.push(shaderTable);
            }
            return true;
        }

        // CreateCompositingPipeline: the trace images, the composited image and the displayed one;
        // the pass as a push constant.
        createCompositingPipeline() {
            const layoutDesc = BindingLayoutDesc.create();
            for (let u = 0; u < 5; u++) {
                layoutDesc.layoutTextureUAV(u);
            }
            layoutDesc.layoutPushConstants(0, 4);
            this.compositeLayout = this.app.createBindingLayout(layoutDesc, ShaderType.Compute);
            const shader = this.app.createShader("partitioned_tlas/compositing.hlsl", "Composite", ShaderType.Compute);
            if (!shader) {
                return false;
            }
            this.compositePipeline = this.app.createComputePipelineWithLayout(shader, this.compositeLayout);
            this.app.releaseResource(shader);
            return true;
        }

        // The images have the back buffers' size (times the render scale).
        onBackBufferResizing() {
            for (const bindingSet of this.rayTracingSets) {
                this.app.releaseResource(bindingSet.handle);
            }
            this.rayTracingSets = [];
            const compositeSet = this.compositeSet;
            if (!compositeSet.isNull()) {
                this.app.releaseResource(compositeSet.handle);
                this.compositeSet = new BindingSet(null);
            }
            for (const image of this.traceImages) {
                this.app.releaseResource(image);
            }
            this.traceImages = [];
            const renderOutput = this.renderOutput;
            const displayOutput = this.displayOutput;
            if (renderOutput && renderOutput != displayOutput) {
                this.app.releaseResource(renderOutput);
            }
            if (displayOutput) {
                this.app.releaseResource(displayOutput);
            }
            this.renderOutput = null;
            this.displayOutput = null;
        }

        // CreateWindowSizeDependentResources and the binding sets over its images.
        createImages(frame: Frame) {
            const scale = this.settings.renderScale;
            const width = frame.getWidth() * scale;
            const height = frame.getHeight() * scale;
            const names = ["Trace image", "Primary image", "Depth image"];
            for (const name of names) {
                this.traceImages.push(this.app.createUAVTextureWithFormat(width, height, Format.RGBA32_FLOAT, name));
            }
            // UNORM, in the back buffer's channel order, for the copy to the frame.
            const displayOutput = this.app.createUAVTextureForFrameCopy(frame, "Presentation output");
            this.displayOutput = displayOutput;
            const renderOutput = scale > 1
                ? this.app.createUAVTextureWithFormat(width, height, Format.RGBA8_UNORM, "Render output") : displayOutput;
            this.renderOutput = renderOutput;

            for (let regular = 0; regular < 2; regular++) {
                for (let physics = 0; physics < 2; physics++) {
                    const desc = BindingSetDesc.create();
                    if (regular == 0) {
                        desc.bindPartitionedAccelStruct(0, this.ptlas.getBuffer());
                    } else {
                        desc.bindAccelStruct(0, this.ptlas.getReferenceTlas());
                    }
                    desc.bindRawBufferSRV(1, this.instancePartitions);
                    desc.bindRawBufferSRV(2, this.partitionActivity);
                    desc.bindRawBufferSRV(3, this.physicsState[physics]);
                    desc.bindRawBufferSRV(4, this.triangleData);
                    for (let u = 0; u < 3; u++) {
                        desc.bindTextureUAV(u, this.traceImages[u]);
                    }
                    desc.bindRawBufferUAV(3, this.pickResult);
                    desc.bindConstantBuffer(0, this.frameConstants, 0, 256);
                    this.rayTracingSets.push(this.app.createBindingSetForLayout(desc, this.rayTracingLayouts[regular]));
                }
            }

            const desc = BindingSetDesc.create();
            for (let u = 0; u < 3; u++) {
                desc.bindTextureUAV(u, this.traceImages[u]);
            }
            desc.bindTextureUAV(3, renderOutput);
            desc.bindTextureUAV(4, displayOutput);
            desc.bindPushConstants(0, 4);
            this.compositeSet = this.app.createBindingSetForLayout(desc, this.compositeLayout);
        }

        onKey(key: Key, scancode: ScanCode, action: Action, mods: KeyMods): int {
            if (key >= 0 && key < this.keysDown.length) {
                if (action == Action.Press) {
                    this.keysDown[key] = true;
                } else if (action == Action.Release) {
                    this.keysDown[key] = false;
                }
            }
            if (action != Action.Press) {
                return 0;
            }
            // UpdateInput's keys.
            const settings = this.settings;
            if (key == Key.P || key == Key.Space) {
                settings.usePtlas = !settings.usePtlas;
            } else if (key == Key.Num1) {
                settings.updateMode = 0;
            } else if (key == Key.Num2) {
                settings.updateMode = 1;
            } else if (key == Key.Num3) {
                settings.updateMode = 2;
            } else if (key == Key.F) {
                settings.paused = !settings.paused;
            } else if (key == Key.N) {
                this.step = true;
            } else if (key == Key.R) {
                this.reset = true;
            } else if (key == Key.T) {
                settings.tlasRefit = !settings.tlasRefit;
            } else if (key == Key.C) {
                settings.showPartitionColors = !settings.showPartitionColors;
            } else {
                return 0;
            }
            return 1;
        }

        // A left drag looks around (WindowProc's WM_MOUSEMOVE).
        onMousePos(x: number, y: number): int {
            if (this.dragging) {
                this.cameraYaw = Math.fround(this.cameraYaw + Math.fround(Math.fround(x - this.mouseX) * Math.fround(0.005)));
                const pitch = Math.fround(this.cameraPitch - Math.fround(Math.fround(y - this.mouseY) * Math.fround(0.005)));
                this.cameraPitch = Math.min(Math.max(pitch, -1.5), 1.5);
            }
            this.mouseX = x;
            this.mouseY = y;
            return this.dragging ? 1 : 0;
        }

        // A right click topples the domino under the cursor.
        onMouseButton(button: MouseButton, action: Action, mods: KeyMods): int {
            if (button == MouseButton.Left) {
                this.dragging = action == Action.Press;
                return 1;
            }
            if (button == MouseButton.Right && action == Action.Press) {
                this.pickX = this.mouseX;
                this.pickY = this.mouseY;
                this.pickRequested = true;
                return 1;
            }
            return 0;
        }

        onAnimate(elapsedSeconds: number) {
            this.elapsed = Math.min(elapsedSeconds, 0.05);
            if (this.elapsed > 0.0) {
                this.fps = this.fps * 0.9 + 0.1 / this.elapsed;
            }
            const settings = this.settings;
            this.app.setWindowTitle(`${WINDOW_TITLE} | ${formatFixed(this.fps, 0)} FPS | ${settings.usePtlas ? "PTLAS" : "TLAS"}`
                + ` | ${MODE_NAMES[settings.updateMode]} | ${settings.paused ? "paused" : "running"} | ${this.lastChangedCount} writes`
                + ` | update ${formatFixed(this.gpuUpdateMs, 2)} ms | trace ${formatFixed(this.gpuTraceMs, 2)} ms`);
        }

        // CollectFrame: a frame's write count, pick and GPU times, FRAMES_IN_FLIGHT frames later.
        collectFrame(slot: int) {
            if (this.readbackPending[slot]) {
                const values: int[] = [0, 0];
                if (this.app.readBuffer(this.readbacks[slot], Ref(values[0]), 8)) {
                    this.lastChangedCount = this.readbackPtlas[slot] ? values[0] : 0;
                    if (this.readbackPtlas[slot]) {
                        while (this.writeCounts.length <= this.readbackFrame[slot]) {
                            this.writeCounts.push(-1);
                        }
                        this.writeCounts[this.readbackFrame[slot]] = values[0];
                    }
                    if (this.readbackPick[slot] && values[1] >= 0 && values[1] < DOMINO_COUNT) {
                        this.toppleIndex = values[1];
                        this.manualTopple = true;
                        this.settings.paused = false;
                    }
                }
                this.readbackPending[slot] = false;
            }
            if (this.timerPending[slot] && this.app.pollTimerQuery(this.updateTimers[slot]) != 0
                && this.app.pollTimerQuery(this.traceTimers[slot]) != 0) {
                this.gpuUpdateMs = 1000.0 * this.app.getTimerQueryTime(this.updateTimers[slot]);
                this.gpuTraceMs = 1000.0 * this.app.getTimerQueryTime(this.traceTimers[slot]);
                this.app.resetTimerQuery(this.updateTimers[slot]);
                this.app.resetTimerQuery(this.traceTimers[slot]);
                this.timerPending[slot] = false;
            }
        }

        // UpdateCamera: WASD / QE (Shift: faster), then FrameConstants.
        updateCamera(width: int, height: int, pickActive: boolean) {
            const settings = this.settings;
            const cosPitch = Math.fround(Math.cos(this.cameraPitch));
            const forward = [
                Math.fround(Math.fround(Math.sin(this.cameraYaw)) * cosPitch),
                Math.fround(Math.sin(this.cameraPitch)),
                Math.fround(Math.fround(Math.cos(this.cameraYaw)) * cosPitch),
            ];
            const right = normalize3(cross3(forward, [0.0, 1.0, 0.0]));
            const shift = this.keysDown[Key.LeftShift] || this.keysDown[Key.RightShift];
            const distance = Math.fround(Math.fround(10.0 * (shift ? 5.0 : 1.0)) * this.elapsed);
            const eye = this.cameraEye;
            for (let k = 0; k < 3; k++) {
                if (this.keysDown[Key.W]) {
                    eye[k] = Math.fround(eye[k] + Math.fround(forward[k] * distance));
                }
                if (this.keysDown[Key.S]) {
                    eye[k] = Math.fround(eye[k] - Math.fround(forward[k] * distance));
                }
                if (this.keysDown[Key.D]) {
                    eye[k] = Math.fround(eye[k] + Math.fround(right[k] * distance));
                }
                if (this.keysDown[Key.A]) {
                    eye[k] = Math.fround(eye[k] - Math.fround(right[k] * distance));
                }
            }
            if (this.keysDown[Key.E]) {
                eye[1] = Math.fround(eye[1] + distance);
            }
            if (this.keysDown[Key.Q]) {
                eye[1] = Math.fround(eye[1] - distance);
            }

            // SimpleMath's right-handed CreateLookAt and CreatePerspectiveFieldOfView (60 degrees, 0.1
            // to 10000), view * projection inverted.
            const eye4 = [eye[0], eye[1], eye[2], 0.0];
            const at = [Math.fround(eye[0] + forward[0]), Math.fround(eye[1] + forward[1]), Math.fround(eye[2] + forward[2]), 0.0];
            const view = matrixLookAtRH(eye4, at, [0.0, 1.0, 0.0, 0.0]);
            const aspect = Math.fround(Math.fround(width) / Math.fround(height));
            const projection = matrixPerspectiveFovRH(radians(60.0), aspect, 0.1, 10000.0);
            const inverse = matrixInverse(matrixMultiply(view, projection));
            const c = this.frameData;
            for (let i = 0; i < 16; i++) {
                c[i] = inverse[i];
            }
            c[16] = eye[0];
            c[17] = eye[1];
            c[18] = eye[2];
            c[19] = 1.0;
            storeUint(c, 20, PARTITIONS_PER_AXIS);
            storeUint(c, 21, this.frameIndex);
            storeUint(c, 22, settings.showPartitionColors && settings.usePtlas ? 1 : 0);
            c[23] = this.sceneExtent();
            // The sun: azimuth 0, elevation 45 degrees.
            const elevation = radians(45.0);
            c[24] = 0.0;
            c[25] = Math.fround(Math.sin(elevation));
            c[26] = Math.fround(Math.cos(elevation));
            c[27] = 0.0;
            // Metallic, roughness, light intensity, maximum ray depth.
            c[28] = Math.fround(0.1);
            c[29] = 1.0;
            c[30] = 5.0;
            c[31] = MAX_RECURSION_DEPTH;
            const scale = settings.renderScale;
            storeUint(c, 32, Math.floor(this.pickX) * scale + Math.floor(scale / 2));
            storeUint(c, 33, Math.floor(this.pickY) * scale + Math.floor(scale / 2));
            storeUint(c, 34, pickActive ? 1 : 0);
            storeUint(c, 35, 0);
        }

        getRenderOutput(): TextureHandle | null {
            return this.renderOutput;
        }

        // The scene's half extent: m_dominoesPerAxis * 1.3f * 0.5f.
        sceneExtent(): number {
            return Math.fround(Math.fround(DOMINOES_PER_AXIS * Math.fround(DOMINO_SPACING)) * 0.5);
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const commandList = frame.getCommandList();
            const settings = this.settings;
            const width = frame.getWidth();
            const height = frame.getHeight();
            if (this.rayTracingSets.length == 0) {
                this.createImages(frame);
            }
            const slot = this.frameIndex % FRAMES_IN_FLIGHT;
            this.collectFrame(slot);

            // UpdateAnimation.
            const advancePhysics = !settings.paused || this.step;
            this.step = false;
            if (this.reset) {
                this.reset = false;
                this.manualTopple = false;
                this.physicsResetPending = true;
                this.ptlasNeedsSync = true;
                this.tlasNeedsSync = true;
            }
            const pickActive = this.pickRequested && this.pickX >= 0.0 && this.pickY >= 0.0
                && this.pickX < width && this.pickY < height;
            this.pickRequested = false;
            this.updateCamera(width, height, pickActive);
            commandList.writeBuffer(this.frameConstants, Ref(this.frameData[0]), FRAME_CONSTANTS_SIZE);

            commandList.beginTimerQuery(this.updateTimers[slot]);
            this.generateInstanceUpdates(commandList, advancePhysics);
            this.updateAccelerationStructure(commandList);
            commandList.endTimerQuery(this.updateTimers[slot]);
            // CaptureStateDump: the physics state this frame traces.
            if (this.frameIndex == settings.stateDumpFrame) {
                const stateDump = this.app.createReadbackBuffer(DOMINO_COUNT * MOTION_SIZE, "State dump");
                commandList.copyBuffer(stateDump, 0, this.physicsState[this.physicsCurrentIndex], 0, DOMINO_COUNT * MOTION_SIZE);
                this.stateDump = stateDump;
            }
            if (settings.usePtlas) {
                // ReadbackPtlasWriteCount: the GPU's write count, for the title.
                commandList.copyBuffer(this.readbacks[slot], 0, this.ptlas.getOperations(), 12, 4);
            }

            // DoRaytracing.
            const regular = settings.usePtlas ? 0 : 1;
            const scale = settings.renderScale;
            commandList.beginTimerQuery(this.traceTimers[slot]);
            frame.dispatchRays(this.shaderTables[regular], this.rayTracingSets[regular * 2 + this.physicsCurrentIndex],
                width * scale, height * scale);
            commandList.endTimerQuery(this.traceTimers[slot]);
            if (pickActive) {
                commandList.copyBuffer(this.readbacks[slot], 4, this.pickResult, 0, 4);
            }
            this.readbackPending[slot] = true;
            this.readbackPtlas[slot] = settings.usePtlas;
            this.readbackPick[slot] = pickActive;
            this.readbackFrame[slot] = this.frameIndex;
            this.timerPending[slot] = true;

            // Composite: four passes at the render resolution, a fifth averaging it down.
            const groupsX = Math.floor((width * scale + COMPOSITE_GROUP_SIZE - 1) / COMPOSITE_GROUP_SIZE);
            const groupsY = Math.floor((height * scale + COMPOSITE_GROUP_SIZE - 1) / COMPOSITE_GROUP_SIZE);
            for (let pass = 0; pass < 4; pass++) {
                this.compositeData[0] = pass;
                commandList.dispatchWithPushConstants(this.compositePipeline, this.compositeSet, Ref(this.compositeData[0]), 4,
                    groupsX, groupsY, 1);
            }
            if (scale == 2) {
                this.compositeData[0] = 4;
                commandList.dispatchWithPushConstants(this.compositePipeline, this.compositeSet, Ref(this.compositeData[0]), 4,
                    Math.floor((width + COMPOSITE_GROUP_SIZE - 1) / COMPOSITE_GROUP_SIZE),
                    Math.floor((height + COMPOSITE_GROUP_SIZE - 1) / COMPOSITE_GROUP_SIZE), 1);
            }
            const displayOutput = this.displayOutput;
            if (displayOutput) {
                frame.copyTextureToFrame(displayOutput);
            }
            this.frameIndex++;
        }

        // GenerateInstanceUpdates: the physics (from the frame's physics buffer to the other), the
        // partitions' activity, then the instances: PTLAS writes appended to a write operation the
        // GPU counts, or every regular TLAS instance.
        generateInstanceUpdates(commandList: CommandList, advancePhysics: boolean) {
            const settings = this.settings;
            if (settings.usePtlas) {
                this.ptlas.resetGpuWrites(commandList.handle);
                this.tlasNeedsSync = true;
            } else {
                this.ptlasNeedsSync = true;
            }
            const a = this.animationData;
            storeUint(a, 0, settings.updateMode);
            storeUint(a, 1, settings.usePtlas ? 1 : 0);
            storeUint(a, 2, settings.usePtlas && this.ptlasNeedsSync ? 1 : 0);
            storeUint(a, 3, DOMINO_COUNT);
            storeUint(a, 4, 0);
            storeUint(a, 5, PARTITIONS_PER_AXIS);
            a[6] = this.cameraEye[0];
            a[7] = this.cameraEye[2];
            // The global distance: max(22, axis * 1.3 / 10).
            a[8] = 22.0;
            a[9] = this.sceneExtent();
            storeUint(a, 10, this.manualTopple ? 1 : 0);
            storeUint(a, 11, this.toppleIndex);
            a[12] = this.cameraEye[1];
            storeUint(a, 13, this.frameIndex);
            storeUint(a, 14, this.physicsResetPending ? 1 : 0);
            storeUint(a, 15, advancePhysics && !this.physicsResetPending ? 1 : 0);
            storeUint(a, 16, settings.selfToppleCount);
            storeUint(a, 17, settings.markAllInPartition ? 1 : 0);
            a[18] = Math.fround(0.008);

            const current = this.physicsCurrentIndex;
            const next = 1 - current;
            const groups = Math.floor((DOMINO_COUNT + GROUP_SIZE - 1) / GROUP_SIZE);
            commandList.dispatchWithPushConstants(this.simulatePipeline, this.simulateSets[current], Ref(a[0]),
                ANIMATION_CONSTANTS_SIZE, groups, 1, 1);
            if (this.physicsResetPending) {
                // Both buffers start from the initial state.
                commandList.copyBuffer(this.physicsState[current], 0, this.physicsState[next], 0, DOMINO_COUNT * MOTION_SIZE);
            }
            commandList.dispatchWithPushConstants(this.markPartitionsPipeline, this.markPartitionsSets[current], Ref(a[0]),
                ANIMATION_CONSTANTS_SIZE, groups, 1, 1);
            commandList.dispatchWithPushConstants(this.animatePipeline, this.animateSets[current], Ref(a[0]),
                ANIMATION_CONSTANTS_SIZE, groups, 1, 1);
            this.physicsCurrentIndex = next;
            this.physicsResetPending = false;
            this.manualTopple = false;
            if (settings.usePtlas) {
                this.ptlasNeedsSync = false;
            }
        }

        // UpdateAccelerationStructure: the PTLAS updated in place by the GPU-counted writes, or the
        // regular TLAS refitted (or rebuilt: T, or after the PTLAS was selected).
        updateAccelerationStructure(commandList: CommandList) {
            if (this.settings.usePtlas) {
                this.ptlas.buildFromOperations(commandList.handle);
            } else {
                this.ptlas.updateReferenceTlas(commandList.handle, DOMINO_COUNT,
                    this.settings.tlasRefit && !this.tlasNeedsSync ? 1 : 0);
                this.tlasNeedsSync = false;
            }
        }
    }

    // The sample's settings, as an ImGui window: what its keys toggle, and its stats.
    class UserInterface {
        private sample: PartitionedTlasPass;
        private settings: Settings;

        constructor(sample: PartitionedTlasPass, settings: Settings) {
            this.sample = sample;
            this.settings = settings;
        }

        init(app: App) {
            return !app.addImGuiPass(this.buildUI).isNull();
        }

        buildUI() {
            const settings = this.settings;
            ImGui.setNextWindowPos(10.0, 10.0);
            ImGui.begin("Partitioned TLAS", true);
            settings.usePtlas = ImGui.checkbox("Partitioned TLAS (P)", settings.usePtlas);
            for (let mode = 0; mode < 3; mode++) {
                if (ImGui.radioButton(`${mode + 1}: ${MODE_NAMES[mode]}`, settings.updateMode == mode)) {
                    settings.updateMode = mode;
                }
            }
            settings.showPartitionColors = ImGui.checkbox("Partition colors (C)", settings.showPartitionColors);
            settings.markAllInPartition = ImGui.checkbox("Move a moving partition's dominoes together", settings.markAllInPartition);
            settings.tlasRefit = ImGui.checkbox("Refit the regular TLAS (T)", settings.tlasRefit);
            settings.paused = ImGui.checkbox("Paused (F)", settings.paused);
            ImGui.text("N: single step, R: reset the motion");
            ImGui.text("WASD / QE: move, left drag: look, right click: topple");
            ImGui.separator();
            const sample = this.sample;
            ImGui.text(`${sample.lastChangedCount} instance writes`);
            ImGui.text(`GPU update ${formatFixed(sample.gpuUpdateMs, 3)} ms, trace ${formatFixed(sample.gpuTraceMs, 3)} ms`);
            ImGui.end();
        }
    }

    class PartitionedTlasArgs extends Args {
        // The sample's options: -tlas (--tlas), -mode 1..3, -noPartitionColors, -paused,
        // -selfToppleCount N (0: none), -markAll, -renderScale 1..2, -ptlasHint none|build|trace,
        // -stateDump <file>, -image <file>.
        settings = new Settings();

        protected parseOptions() {
            const settings = this.settings;
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-tlas") {
                    settings.usePtlas = false;
                } else if (arg == "-noPartitionColors") {
                    settings.showPartitionColors = false;
                } else if (arg == "-paused") {
                    settings.paused = true;
                } else if (arg == "-markAll") {
                    settings.markAllInPartition = true;
                } else if (arg == "-mode" && i + 1 < this.argc) {
                    i++;
                    settings.updateMode = Math.min(Math.max(parseInt(this[i]), 1), 3) - 1;
                } else if (arg == "-selfToppleCount" && i + 1 < this.argc) {
                    i++;
                    settings.selfToppleCount = Math.max(parseInt(this[i]), 0);
                } else if (arg == "-renderScale" && i + 1 < this.argc) {
                    i++;
                    settings.renderScale = Math.min(Math.max(parseInt(this[i]), 1), 2);
                } else if (arg == "-image" && i + 1 < this.argc) {
                    i++;
                    settings.imagePath = this[i];
                } else if (arg == "-stateDump" && i + 1 < this.argc) {
                    i++;
                    settings.stateDumpPath = this[i];
                } else if (arg == "-ptlasHint" && i + 1 < this.argc) {
                    i++;
                    const hint = this[i];
                    settings.ptlasFlags = hint == "build" ? PTLAS_FAST_BUILD : hint == "trace" ? PTLAS_FAST_TRACE : 0;
                }
            }
        }
    }

    // -test: checks the last frame: the sky at the top corners, the ground (the sky's lower half)
    // at the bottom ones, the dominoes in between: dark, partition-colored on their tops and edges
    // with the PTLAS (not with the regular TLAS, as the sample).
    function checkFrame(app: App, settings: Settings, writeCounts: int[]) {
        // The instance writes the GPU counted: every domino on the first frame (the PTLAS's first
        // sync), then the moving ones (all on the second frame in mode 2, settling onto the ground)
        // on most frames.
        if (settings.usePtlas) {
            if (writeCounts.length < 2 || writeCounts[0] != DOMINO_COUNT) {
                return `the first frame wrote ${writeCounts.length > 0 ? writeCounts[0] : -1} instances, not ${DOMINO_COUNT}`;
            }
            let moving = 0;
            for (let f = 1; f < writeCounts.length; f++) {
                if (writeCounts[f] < 0 || writeCounts[f] > DOMINO_COUNT) {
                    return `frame ${f} wrote ${writeCounts[f]} instances`;
                }
                moving += writeCounts[f] > 0 ? 1 : 0;
            }
            console.log(`Frames writing moving dominoes: ${moving} of ${writeCounts.length - 1}`);
            if (moving < (writeCounts.length - 1) / 2) {
                return `only ${moving} frames wrote instances`;
            }
        }
        const check = new TestCheck(app);
        const failure = check.frameRead();
        if (failure != "") {
            return failure;
        }
        const w = check.width;
        const h = check.height;
        // Sky blue at the top (b > r + 60), the ground's gray-beige at the bottom.
        if (check.countInRange(100, 150, 150, 200, 210, 255, 0, 0, 1, 1) != 1
            || check.countInRange(100, 150, 150, 200, 210, 255, w - 1, 0, 1, 1) != 1) {
            return `the top corners aren't the sky: ${check.rgb(0, 0) & 0xFF}, ${(check.rgb(0, 0) >> 8) & 0xFF}, ${(check.rgb(0, 0) >> 16) & 0xFF}`;
        }
        if (check.countInRange(140, 175, 135, 170, 125, 160, 0, h - 1, 1, 1) != 1
            || check.countInRange(140, 175, 135, 170, 125, 160, w - 1, h - 1, 1, 1) != 1) {
            const p = check.rgb(0, h - 1);
            return `the bottom corners aren't the ground: ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}`;
        }
        // The dominoes: near-black pixels in the middle of the frame.
        const dark = check.countInRange(0, 40, 0, 40, 0, 40, 0, 0, w, h);
        const darkFailure = check.share(dark, w * h, 3.0, 15.0, "Dominoes (dark)");
        if (darkFailure != "") {
            return darkFailure;
        }
        // Partition colors: saturated pixels (their tops and edges).
        const colored = check.countSpread(120, false, 0, 0, Math.floor(h / 3), w, Math.floor(h / 2));
        const shown = settings.showPartitionColors && settings.usePtlas;
        return check.share(colored, w * h, shown ? 0.01 : 0.0, shown ? 5.0 : 0.0, "Partition-colored");
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Program.setAppName("partitioned_tlas");

        const args = new PartitionedTlasArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();
        const settings = args.settings;
        settings.api = args.api;
        if (args.test && settings.stateDumpPath != "") {
            settings.stateDumpFrame = TEST_FRAMES - 1;
        }

        // D3D12's PTLAS is a preview: its experimental features before the device (the executable
        // loads the preview runtime, which needs Windows' Developer Mode).
        if (args.api == GraphicsAPI.D3D12 && Donut_EnableD3D12RaytracingPreview() == 0) {
            return unsupported(args.test, "The D3D12 PTLAS preview is unavailable (needs the preview Agility SDK and Developer Mode)");
        }
        // UNORM back buffers, as the sample's R8G8B8A8_UNORM.
        const options = AppOptions.RayTracing | AppOptions.UnormBackBuffer | args.options;
        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        if (!app.isFeatureSupported(Feature.RayTracingPipeline) || !app.isFeatureSupported(Feature.RayQuery)) {
            app.destroy();
            return unsupported(args.test, "The graphics device does not support ray tracing pipelines and ray queries");
        }
        // The PTLAS: an instance slot per domino, the global partition room for them all; the regular
        // TLAS beside it, refittable.
        const ptlas = Ptlas.create(app.getNvrhiDevice(), DOMINO_COUNT, MAX_INSTANCES_PER_PARTITION, PARTITION_COUNT,
            DOMINO_COUNT, settings.ptlasFlags | PTLAS_UPDATABLE_REFERENCE_TLAS);
        if (ptlas.isNull()) {
            app.destroy();
            return unsupported(args.test, "The graphics device does not support partitioned TLASes");
        }
        console.log(`Renderer: ${app.getRendererString()}`);

        const pass = new PartitionedTlasPass(app, ptlas, settings);
        if (!pass.init()) {
            ptlas.destroy();
            app.destroy();
            return 1;
        }

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(pass, settings);
        if (!args.noUI && !args.test && !gui.init(app)) {
            console.log("Cannot initialize the user interface");
            ptlas.destroy();
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        let result = 0;
        if (args.test) {
            result = app.finishTest(checkFrame(app, settings, pass.writeCounts));
        }
        app.waitForIdle();
        const stateDump = pass.stateDump;
        if (stateDump) {
            const state: int[] = [];
            for (let i = 0; i < DOMINO_COUNT * MOTION_SIZE / 4; i++) {
                state.push(0);
            }
            if (!app.readBuffer(stateDump, Ref(state[0]), state.length * 4)
                || Donut_WriteBinaryFile(settings.stateDumpPath, Ref(state[0]), state.length * 4) == 0) {
                console.log(`Cannot write ${settings.stateDumpPath}`);
                result = 1;
            }
        }
        const renderOutput = pass.getRenderOutput();
        if (args.test && settings.imagePath != "" && renderOutput) {
            const scale = settings.renderScale;
            const pixels: int[] = [];
            for (let i = 0; i < app.getWindowWidth() * scale * app.getWindowHeight() * scale; i++) {
                pixels.push(0);
            }
            const bytes = app.readTextureLevel(renderOutput, 0, Ref(pixels[0]), pixels.length * 4);
            if (bytes == 0 || Donut_WriteBinaryFile(settings.imagePath, Ref(pixels[0]), bytes) == 0) {
                console.log(`Cannot write ${settings.imagePath}`);
                result = 1;
            }
        }
        ptlas.destroy();
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return PartitionedTlas.main(argc, argv);
}

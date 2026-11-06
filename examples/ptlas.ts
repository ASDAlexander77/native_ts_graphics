// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, unsupported } from "../core/test_check";
import { Ptlas } from "../core/ptlas";

namespace PtlasExample {
    // Test mode: the frames rendered - past the instance updates of frames 60 and 120, with three
    // tiles spun.
    const TEST_FRAMES = 130;

    // -test: checks the last frame: no pixel where the PTLAS and the reference TLAS disagree
    // (magenta), the sky at the top corners, and the ground and cubes in between.
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        if (check.frameRead() != "") {
            return check.frameRead();
        }
        const mismatches = check.countInRange(250, 255, 0, 5, 250, 255, 0, 0, check.width, check.height);
        if (mismatches != 0) {
            return `${mismatches} pixels where the PTLAS and the reference TLAS disagree`;
        }
        // The sky (linearToSrgb(0.25, 0.35, 0.5)) at the top corners, not in the middle, and about a
        // third of the frame.
        const total = check.width * check.height;
        const sky = check.countInRange(130, 142, 155, 167, 182, 194, 0, 0, check.width, check.height);
        if (check.countInRange(130, 142, 155, 167, 182, 194, 0, 0, 1, 1) != 1
            || check.countInRange(130, 142, 155, 167, 182, 194, check.width - 1, 0, 1, 1) != 1) {
            return "the top corners aren't the sky";
        }
        if (check.countInRange(130, 142, 155, 167, 182, 194, check.width / 2, check.height / 2, 1, 1) != 0) {
            return "the middle of the frame is the sky";
        }
        return check.share(sky, total, 15.0, 60.0, "Sky");
    }

    const WINDOW_TITLE = "Donut Example: Partitioned TLAS";

    // ptlas_scene.hlsli's scene: a 16 x 16 grid of cubes in 16 partitions (a 4 x 4 tile each), a
    // ground plane and 8 orbiting cubes in the global partition, which half the spinning tile's cubes
    // join while it spins.
    const PARTITION_COUNT = 16;
    const INSTANCES_PER_PARTITION = 16;
    const GLOBAL_INSTANCES = 9;
    const MIGRATING_INSTANCES = INSTANCES_PER_PARTITION / 2;
    const INSTANCE_COUNT = PARTITION_COUNT * INSTANCES_PER_PARTITION + GLOBAL_INSTANCES;
    const ORBITER_COUNT = 8;
    const FRAMES_PER_PHASE = 60;
    // Instance writes after frame 0: the orbiters and the spinning tile's cubes, and at a phase's
    // first frame the last tile's migrated half back into its partition. Instance updates at a
    // phase's first frame: half a tile's cubes.
    const SPARSE_WRITES = ORBITER_COUNT + INSTANCES_PER_PARTITION;
    const UPDATES = INSTANCES_PER_PARTITION / 2;
    const ANIMATE_GROUP_SIZE = 64;

    // Donut_CreatePtlas's flags.
    const PTLAS_FAST_TRACE = 1;
    const PTLAS_PARTITION_TRANSLATION = 4;

    // struct RayPayload { float3 color; float hitT; uint instance, primitive; }.
    const PAYLOAD_SIZE = 24;
    const UINT_SIZE = 4;
    const FLOAT3_SIZE = 12;

    // The BLASes: a cube and an octahedron of about the same size (swapped by instance updates), and
    // the ground's square.
    const CUBE_VERTICES = [
        -0.4, -0.4, -0.4, 0.4, -0.4, -0.4, 0.4, 0.4, -0.4, -0.4, 0.4, -0.4,
        -0.4, -0.4, 0.4, 0.4, -0.4, 0.4, 0.4, 0.4, 0.4, -0.4, 0.4, 0.4,
    ];
    // Two triangles a face (ptlas.hlsl shades by PrimitiveIndex() / 2).
    const CUBE_INDICES = [
        0, 2, 1, 0, 3, 2,
        4, 5, 6, 4, 6, 7,
        0, 1, 5, 0, 5, 4,
        3, 7, 6, 3, 6, 2,
        0, 4, 7, 0, 7, 3,
        1, 2, 6, 1, 6, 5,
    ];
    const OCTAHEDRON_VERTICES = [
        0.5, 0.0, 0.0, -0.5, 0.0, 0.0, 0.0, 0.5, 0.0, 0.0, -0.5, 0.0, 0.0, 0.0, 0.5, 0.0, 0.0, -0.5,
    ];
    const OCTAHEDRON_INDICES = [
        0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4,
        2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5,
    ];
    const GROUND_VERTICES = [
        -1.0, 0.0, -1.0, 1.0, 0.0, -1.0, 1.0, 0.0, 1.0, -1.0, 0.0, 1.0,
    ];
    const GROUND_INDICES = [0, 2, 1, 0, 3, 2];

    // --- Passes -----------------------------------------------------------------------------

    // A partitioned TLAS (VK_NV_partitioned_acceleration_structure, D3D12's preview PTLAS) of 265
    // instance slots, kept up to date by sparse operations a compute shader writes each frame:
    // instance writes for what moved (the orbiters, the spinning tile - half of it moved into the
    // global partition while it spins, then back into its own), instance updates swapping the
    // BLAS of half a tile's cubes once a second, and a translation per tile partition (a bob). The
    // same shader writes every instance into an ordinary TLAS, rebuilt each frame, which the ray
    // generation shader traces too, painting magenta wherever the two disagree.
    class PtlasPass {
        private app: App;
        private ptlas: Ptlas;
        private blases: TriangleBlas[];
        // The BLAS builds' vertices and indices.
        private inputBuffers: BufferHandle[];
        // The frame index and -reference (float4).
        private frameConstants: BufferHandle;
        // The BLASes' addresses as instances reference them.
        private blasAddresses: BufferHandle;
        private animatePipeline: ComputePipelineHandle;
        private animateBindingSet: BindingSet;
        private rayTracingBindingLayout: BindingLayoutHandle;
        private shaderTable: ShaderTable;
        // Created on the first frame (it has the frame's size), dropped on resize.
        private storageImage: TextureHandle | null;
        private rayTracingBindingSet: BindingSet;
        private frameIndex: int;
        private constants: f32[];

        // -reference: show the reference TLAS's image instead of the PTLAS's.
        showReference: boolean;

        constructor(app: App, ptlas: Ptlas) {
            this.app = app;
            this.ptlas = ptlas;
            this.blases = [];
            this.inputBuffers = [];
            this.storageImage = null;
            this.animateBindingSet = new BindingSet(null);
            this.rayTracingBindingSet = new BindingSet(null);
            this.frameIndex = 0;
            this.constants = [0.0, 0.0, 0.0, 0.0];
            this.showReference = false;
        }

        init() {
            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutPartitionedAccelStruct(0);
            layoutDesc.layoutAccelStruct(1);
            layoutDesc.layoutTextureUAV(0);
            layoutDesc.layoutConstantBuffer(0);
            this.rayTracingBindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.All);
            if (!this.createRayTracingPipeline()) {
                return false;
            }

            this.frameConstants = this.app.createConstantBuffer(16, "FrameConstants");
            this.blasAddresses = this.app.createConstantBuffer(32, "BlasAddresses");

            const commandList = this.app.createCommandList();
            commandList.open();
            const created = this.createBlases(commandList);
            if (created) {
                const addresses: int[] = [0, 0, 0, 0, 0, 0, 0, 0];
                for (let b = 0; b < 3; b++) {
                    this.ptlas.storeAccelStructAddress(this.blases[b].getAccelStruct(), Ref(addresses[b * 2]));
                }
                commandList.writeBuffer(this.blasAddresses, Ref(addresses[0]), addresses.length * UINT_SIZE);
            }
            commandList.close();
            this.app.executeCommandList(commandList);
            // Only needed for the builds: the command list references them, and the app holds it
            // until the GPU is done with it.
            for (const inputBuffer of this.inputBuffers) {
                this.app.releaseResource(inputBuffer);
            }
            this.app.releaseResource(commandList.handle);
            if (!created) {
                return false;
            }

            const animateShader = this.app.createShader("ptlas_animate.hlsl", "animate_cs", ShaderType.Compute);
            if (!animateShader) {
                return false;
            }
            const animateSetDesc = BindingSetDesc.create();
            animateSetDesc.bindRawBufferUAV(0, this.ptlas.getWriteInstanceArgs());
            animateSetDesc.bindRawBufferUAV(1, this.ptlas.getUpdateInstanceArgs());
            animateSetDesc.bindRawBufferUAV(2, this.ptlas.getTranslatePartitionArgs());
            animateSetDesc.bindRawBufferUAV(3, this.ptlas.getReferenceInstances());
            animateSetDesc.bindEntireConstantBuffer(0, this.frameConstants);
            animateSetDesc.bindEntireConstantBuffer(1, this.blasAddresses);
            this.animateBindingSet = this.app.createBindingSet(animateSetDesc, ShaderType.Compute);
            this.animatePipeline = this.app.createComputePipeline(animateShader, this.animateBindingSet);
            this.app.releaseResource(animateShader);

            const pass = this.app.addPass();
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }

        // The storage image has the back buffers' size.
        onBackBufferResizing() {
            const bindingSet = this.rayTracingBindingSet;
            if (!bindingSet.isNull()) {
                this.app.releaseResource(bindingSet.handle);
                this.rayTracingBindingSet = new BindingSet(null);
            }
            const storageImage = this.storageImage;
            if (storageImage) {
                this.app.releaseResource(storageImage);
                this.storageImage = null;
            }
        }

        onAnimate(elapsedSeconds: number) {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();

            let storageImage = this.storageImage;
            let bindingSet = this.rayTracingBindingSet;
            if (!storageImage || bindingSet.isNull()) {
                storageImage = this.app.createUAVTextureForFrameCopy(frame, "Output");
                const bindingSetDesc = BindingSetDesc.create();
                bindingSetDesc.bindPartitionedAccelStruct(0, this.ptlas.getBuffer());
                bindingSetDesc.bindAccelStruct(1, this.ptlas.getReferenceTlas());
                bindingSetDesc.bindTextureUAV(0, storageImage);
                bindingSetDesc.bindEntireConstantBuffer(0, this.frameConstants);
                bindingSet = this.app.createBindingSetForLayout(bindingSetDesc, this.rayTracingBindingLayout);
                this.storageImage = storageImage;
                this.rayTracingBindingSet = bindingSet;
            }

            const frameIndex = this.frameIndex;
            const commandList = frame.getCommandList();
            this.constants[0] = frameIndex;
            this.constants[1] = this.showReference ? 1.0 : 0.0;
            commandList.writeBuffer(this.frameConstants, Ref(this.constants[0]), 16);

            // The frame's operation arguments and reference instances.
            commandList.dispatch(this.animatePipeline, this.animateBindingSet,
                (INSTANCE_COUNT + ANIMATE_GROUP_SIZE - 1) / ANIMATE_GROUP_SIZE, 1, 1);

            // Frame 0 writes every instance slot (a build from nothing), later frames only what moved.
            const phaseStart = frameIndex > 0 && frameIndex % FRAMES_PER_PHASE == 0;
            const writes = frameIndex == 0 ? INSTANCE_COUNT : phaseStart ? SPARSE_WRITES + MIGRATING_INSTANCES : SPARSE_WRITES;
            const updates = phaseStart ? UPDATES : 0;
            this.ptlas.build(commandList.handle, writes, updates, PARTITION_COUNT);
            this.ptlas.buildReferenceTlas(commandList.handle, INSTANCE_COUNT);

            frame.dispatchRays(this.shaderTable, bindingSet, width, height);
            frame.copyTextureToFrame(storageImage);
            this.frameIndex = frameIndex + 1;
        }

        // The cube's, the octahedron's and the ground's BLASes.
        createBlases(commandList: CommandList) {
            const vertices: f32[] = [];
            const indices: int[] = [];
            const meshes = [CUBE_VERTICES, OCTAHEDRON_VERTICES, GROUND_VERTICES];
            const meshIndices = [CUBE_INDICES, OCTAHEDRON_INDICES, GROUND_INDICES];
            const vertexStarts: int[] = [];
            const indexStarts: int[] = [];
            for (let m = 0; m < 3; m++) {
                vertexStarts.push(vertices.length / 3);
                indexStarts.push(indices.length);
                for (const coordinate of meshes[m]) {
                    vertices.push(coordinate);
                }
                for (const index of meshIndices[m]) {
                    indices.push(index);
                }
            }

            const vertexBuffer = this.app.createAccelStructInputBuffer(vertices.length * 4, "VertexBuffer");
            const indexBuffer = this.app.createAccelStructInputBuffer(indices.length * UINT_SIZE, "IndexBuffer");
            commandList.writeBuffer(vertexBuffer, Ref(vertices[0]), vertices.length * 4);
            commandList.writeBuffer(indexBuffer, Ref(indices[0]), indices.length * UINT_SIZE);
            this.inputBuffers.push(vertexBuffer);
            this.inputBuffers.push(indexBuffer);

            const names = ["Cube", "Octahedron", "Ground"];
            for (let m = 0; m < 3; m++) {
                const blas = this.app.createEmptyTriangleBlas(names[m]);
                blas.addGeometry(indexBuffer, indexStarts[m] * UINT_SIZE, meshIndices[m].length, vertexBuffer,
                    vertexStarts[m] * FLOAT3_SIZE, meshes[m].length / 3, FLOAT3_SIZE, null);
                if (blas.build(this.app, commandList, AccelStructBuildFlags.None) == 0) {
                    return false;
                }
                this.blases.push(blas);
            }
            return true;
        }

        // The ray generation shader, the miss shader and one hit group for every instance.
        createRayTracingPipeline() {
            const shaderLibrary = this.app.createShaderLibrary("ptlas.hlsl");
            if (!shaderLibrary) {
                return false;
            }
            const pipelineDesc = RtPipelineDesc.create(PAYLOAD_SIZE, 1);
            pipelineDesc.addGlobalBindingLayout(this.rayTracingBindingLayout);
            pipelineDesc.addShader(shaderLibrary, "rayGen", ShaderType.RayGeneration);
            pipelineDesc.addShader(shaderLibrary, "miss", ShaderType.Miss);
            pipelineDesc.addHitGroup(shaderLibrary, "HitGroup", "closestHit", "", null);
            const pipeline = this.app.createRayTracingPipelineFromDesc(pipelineDesc);
            if (!pipeline) {
                return false;
            }

            const shaderTable = this.app.createEmptyShaderTable(pipeline);
            // The shader table keeps the pipeline alive.
            this.app.releaseResource(pipeline);
            shaderTable.setRayGeneration("rayGen");
            shaderTable.addMiss("miss");
            shaderTable.addHitGroup("HitGroup", null);
            this.shaderTable = shaderTable;
            return true;
        }
    }

    class PtlasArgs extends Args {
        // -reference: show the reference TLAS's image instead of the PTLAS's.
        reference = false;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-reference") {
                    this.reference = true;
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Program.setAppName("ptlas");

        const args = new PtlasArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        // D3D12's PTLAS is a preview: its experimental features before the device (the executable
        // loads the preview runtime, which needs Windows' Developer Mode).
        if (args.api == GraphicsAPI.D3D12 && Donut_EnableD3D12RaytracingPreview() == 0) {
            return unsupported(args.test, "The D3D12 PTLAS preview is unavailable (needs the preview Agility SDK and Developer Mode)");
        }

        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 800, AppOptions.RayTracing | args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        if (!app.isFeatureSupported(Feature.RayTracingPipeline)) {
            app.destroy();
            return unsupported(args.test, "The graphics device does not support Ray Tracing Pipelines");
        }

        const ptlas = Ptlas.create(app.getNvrhiDevice(), INSTANCE_COUNT, INSTANCES_PER_PARTITION, PARTITION_COUNT,
            GLOBAL_INSTANCES + MIGRATING_INSTANCES, PTLAS_FAST_TRACE | PTLAS_PARTITION_TRANSLATION);
        if (ptlas.isNull()) {
            app.destroy();
            return unsupported(args.test, "The graphics device does not support partitioned TLASes");
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const pass = new PtlasPass(app, ptlas);
        pass.showReference = args.reference;
        if (!pass.init()) {
            ptlas.destroy();
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        let result = 0;
        if (args.test) {
            result = app.finishTest(checkFrame(app));
        }
        // Its buffers and TLAS before the device.
        app.waitForIdle();
        ptlas.destroy();
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return PtlasExample.main(argc, argv);
}

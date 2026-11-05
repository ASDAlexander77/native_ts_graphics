/// <reference path="../core/nri/nri_interop.d.ts" />
import { formatFixed } from "../core/text_format";
import {
    WINDOW_TITLE, CAPACITY, DEFAULT_GRID_HEIGHT, MAX_GRID_LONG, GRID_CAPACITY, MAX_ZOOM,
    PROFILE_EVERY, PROFILE_QUERIES, PROFILE_REPORT, GROUP_SIZE, CONSTANTS_FLOATS, CONSTANTS_SIZE,
    ALL_INT_SECTIONS, I_EVENTS, EVENT_COUNT, FLOAT_SECTIONS, ALLOC_LIST, PARTICLE_SIZE, PROBE_INTS,
    WATER, OIL, SAND, FIRE, LAVA, ACID, SALT, GUNPOWDER, HONEY, PETROL, WALL, GLASS, WOOD, URANIUM,
    EMITTER, ICE, METAL, FAN, BLOCK, BATTERY, LAMP, ERASE, HEAT, COOL, SALT_WATER, SPARK, C4, COAL,
    FUSE, HYDROGEN, OXYGEN, NEON, THERMITE, NITRO, SEED, CLONE, BLACK_HOLE, WHITE_HOLE, SPONGE,
    SWITCH, DETECTOR, HEATER, INSPECT, PROBE, GOAL, AIR_FLOATS, ENTRIES, B_GRID_INT, B_GRID_FLOAT,
    B_CELLS, BUFFERS, Tile, ACTION_SMALLER, ACTION_LARGER, ACTION_PAUSE, ACTION_VIEW, ACTION_CLEAR,
    ACTION_SHAPE, ACTION_UNDO, ACTION_SAVE, ACTION_LOAD, ACTION_LEVEL, ACTION_GRAVITY, GOAL_LIT,
    STATE_BUFFERS, UNDO_DEPTH, multigridFloats, QueuedFrame
} from "./defs";
import { NriGpuProfiler } from "../core/nri_gpu_profiler";
import { SandboxUI } from "./ui";
import { Nri, NriAudio, NriCommandBuffer, NriPipelineDesc, NriPipelineLayoutDesc, NriSample } from "../core/nri";

// The callbacks given to C++, kept for as long as it may call them.
let retainedInitializeCallbacks: NriInitializeCallback[] = [];
let retainedFrameCallbacks: NriFrameCallback[] = [];

// The sandbox, run with NRI: its device, pipelines and buffers, swapchain and frames (its state:
// state.ts; the grid's place on screen: view.ts; its scenes and levels: levels.ts; undo,
// save/load and regrid: saves.ts; the simulation's recording: simulation.ts; the toolbar and
// input: ui.ts).
export class SandboxApp extends SandboxUI {
    constructor(sample: NriSample) {
        super(sample);
        this.kernels.init(CONSTANTS_FLOATS, GROUP_SIZE);
        for (let i = 0; i < PROBE_INTS + EVENT_COUNT; i++) {
            this.probe.push(0);
            this.probeFloats.push(0.0);
        }
        for (let k = 0; k < EVENT_COUNT; k++) {
            this.eventTotals.push(0);
            this.soundCooldowns.push(0.0);
        }
        // The toolbar's tiles, by group (a tool may be in more than one).
        this.groups.push("Liquid");
        this.addTile(0, new Tile("Water", WATER, 0.12, 0.38, 0.9));
        this.addTile(0, new Tile("Salt water", SALT_WATER, 0.1, 0.55, 0.62));
        this.addTile(0, new Tile("Oil", OIL, 0.72, 0.5, 0.12));
        this.addTile(0, new Tile("Petrol", PETROL, 0.95, 0.88, 0.5));
        this.addTile(0, new Tile("Nitro", NITRO, 0.86, 0.9, 0.62));
        this.addTile(0, new Tile("Honey", HONEY, 0.85, 0.55, 0.1));
        this.addTile(0, new Tile("Acid", ACID, 0.45, 0.92, 0.18));
        this.addTile(0, new Tile("Lava", LAVA, 0.85, 0.25, 0.05));
        this.groups.push("Powder");
        this.addTile(1, new Tile("Sand", SAND, 0.86, 0.74, 0.44));
        this.addTile(1, new Tile("Salt", SALT, 0.92, 0.92, 0.95));
        this.addTile(1, new Tile("Gunpowder", GUNPOWDER, 0.2, 0.2, 0.22));
        this.addTile(1, new Tile("Thermite", THERMITE, 0.55, 0.35, 0.3));
        this.addTile(1, new Tile("Seed", SEED, 0.55, 0.45, 0.2));
        this.groups.push("Gas");
        this.addTile(2, new Tile("Fire", FIRE, 1.0, 0.45, 0.1));
        this.addTile(2, new Tile("Hydrogen", HYDROGEN, 0.8, 0.88, 1.0));
        this.addTile(2, new Tile("Oxygen", OXYGEN, 0.5, 0.68, 1.0));
        this.addTile(2, new Tile("Neon", NEON, 1.0, 0.4, 0.3));
        this.groups.push("Solid");
        this.addTile(3, new Tile("Wall", WALL, 0.42, 0.42, 0.45));
        this.addTile(3, new Tile("Glass", GLASS, 0.6, 0.85, 0.92));
        this.addTile(3, new Tile("Wood", WOOD, 0.45, 0.28, 0.12));
        this.addTile(3, new Tile("Coal", COAL, 0.2, 0.19, 0.19));
        this.addTile(3, new Tile("Metal", METAL, 0.6, 0.64, 0.7));
        this.addTile(3, new Tile("Ice", ICE, 0.75, 0.92, 1.0));
        this.addTile(3, new Tile("Block", BLOCK, 0.72, 0.52, 0.3));
        this.addTile(3, new Tile("Sponge", SPONGE, 0.9, 0.85, 0.45));
        this.addTile(3, new Tile("C-4", C4, 0.84, 0.8, 0.68));
        this.addTile(3, new Tile("Fuse", FUSE, 0.5, 0.36, 0.24));
        this.addTile(3, new Tile("Uranium", URANIUM, 0.25, 0.65, 0.2));
        this.groups.push("Power");
        this.addTile(4, new Tile("Battery", BATTERY, 0.75, 0.45, 0.2));
        this.addTile(4, new Tile("Metal", METAL, 0.6, 0.64, 0.7));
        this.addTile(4, new Tile("Lamp", LAMP, 0.95, 0.85, 0.55));
        this.addTile(4, new Tile("Switch", SWITCH, 0.45, 0.2, 0.2));
        this.addTile(4, new Tile("Detector", DETECTOR, 0.75, 0.3, 0.6));
        this.addTile(4, new Tile("Heater", HEATER, 0.6, 0.35, 0.28));
        this.addTile(4, new Tile("Spark", SPARK, 0.7, 0.85, 1.0));
        this.groups.push("Special");
        this.addTile(5, new Tile("Emitter", EMITTER, 0.62, 0.22, 0.62));
        this.addTile(5, new Tile("Clone", CLONE, 0.85, 0.85, 0.3));
        this.addTile(5, new Tile("Fan", FAN, 0.3, 0.5, 0.58));
        this.addTile(5, new Tile("Black hole", BLACK_HOLE, 0.2, 0.08, 0.3));
        this.addTile(5, new Tile("White hole", WHITE_HOLE, 0.9, 0.92, 1.0));
        this.groups.push("Tools");
        this.addTile(6, new Tile("Heat", HEAT, 0.95, 0.25, 0.15));
        this.addTile(6, new Tile("Cool", COOL, 0.3, 0.6, 1.0));
        this.addTile(6, new Tile("Erase", ERASE, 0.35, 0.12, 0.12));
        this.addTile(6, new Tile("Inspect", INSPECT, 0.55, 0.55, 0.6));
        this.addTile(6, new Tile("Shape", ACTION_SHAPE, 0.3, 0.3, 0.3));
        this.addTile(6, new Tile("Brush -", ACTION_SMALLER, 0.3, 0.3, 0.3));
        this.addTile(6, new Tile("Brush +", ACTION_LARGER, 0.3, 0.3, 0.3));
        this.groups.push("Game");
        this.addTile(7, new Tile("Gravity", ACTION_GRAVITY, 0.3, 0.3, 0.3));
        this.addTile(7, new Tile("Pause", ACTION_PAUSE, 0.3, 0.3, 0.3));
        this.addTile(7, new Tile("View", ACTION_VIEW, 0.3, 0.3, 0.3));
        this.addTile(7, new Tile("Clear", ACTION_CLEAR, 0.3, 0.3, 0.3));
        this.addTile(7, new Tile("Undo", ACTION_UNDO, 0.3, 0.3, 0.3));
        this.addTile(7, new Tile("Save", ACTION_SAVE, 0.3, 0.3, 0.3));
        this.addTile(7, new Tile("Load", ACTION_LOAD, 0.3, 0.3, 0.3));
        this.addTile(7, new Tile("Levels", ACTION_LEVEL, 0.3, 0.3, 0.3));
        this.showGroup(0);
    }

    // Renders until the window is closed (in test mode, the test's frames); the exit code.
    run(argc: int, argv: Ref<string>): int {
        const initialize: NriInitializeCallback = this.initialize;
        const latencySleep: NriFrameCallback = this.latencySleep;
        const renderFrame: NriFrameCallback = this.renderFrame;
        retainedInitializeCallbacks.push(initialize);
        retainedFrameCallbacks.push(latencySleep);
        retainedFrameCallbacks.push(renderFrame);
        this.sample.setInitializeCallback(initialize);
        this.sample.setLatencySleepCallback(latencySleep);
        this.sample.setRenderFrameCallback(renderFrame);

        let result = this.sample.run(argc, argv, WINDOW_TITLE, this.testFrames);
        if (result == 0 && this.test) {
            console.log(`Simulation: ${formatFixed(this.stepMs, 3)} ms a step (GPU)`);
            const failure = this.checkTest();
            console.log(failure == "" ? "Test PASSED" : `Test FAILED: ${failure}`);
            result = failure == "" ? 0 : 1;
        }
        this.destroy();
        return result;
    }

    initialize(graphicsAPI: NriGraphicsAPI): int {
        if (this.sceneFile != "") {
            this.startLevel(this.readLevel(this.sceneFile));
        }
        const device = this.sample.createDevice(graphicsAPI);
        if (!device) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 0;
        }
        this.device = device;
        console.log(`Renderer: ${Nri.getGraphicsAPIString(graphicsAPI)} (${device.getAdapterName()})`);

        this.queue = device.getGraphicsQueue();
        this.test = this.sample.isTest() != 0;
        // (a test's default scene is the U-tube, not a level's empty one)
        if (this.test && this.scene == 0 && !this.level) {
            this.scene = 1;
        }
        this.startQuality();
        if ((!this.test || this.soundCheck) && !this.mute) {
            this.audio = NriAudio.create();
            console.log(this.audio ? "Sound: the audio output started" : "No sound: no audio output");
        }

        const queuedFrameNum = this.sample.getQueuedFrameNum();
        this.swapChain.init(this.sample, device, this.queue, false);
        this.sizeToSwapChain();
        const format = this.viewFormat;
        this.fitGrid();
        this.zoom = Math.min(Math.max(this.startZoom, 1.0), MAX_ZOOM);
        this.layout();
        this.stateW = this.gridW;
        this.stateH = this.gridH;

        // Queued frames
        const queryPool = device.createTimestampQueryPool(2 * queuedFrameNum);
        this.queryPool = queryPool;
        if (queryPool) {
            this.querySize = queryPool.getQuerySize();
        }
        if (this.profile) {
            const profiler = new NriGpuProfiler();
            if (profiler.init(device, ENTRIES, PROFILE_QUERIES, PROFILE_EVERY, PROFILE_REPORT)) {
                this.profiler = profiler;
                this.kernels.setProfiler(profiler);
            } else {
                profiler.destroy();
            }
        }
        this.frames.init(device, this.queue, queuedFrameNum);
        for (let i = 0; i < queuedFrameNum; i++) {
            const probeReadback = device.createReadbackBuffer((PROBE_INTS + EVENT_COUNT) * 4);
            if (!probeReadback) {
                console.log("Cannot create the readback buffers");
                return 0;
            }
            const timestampReadback = queryPool ? device.createReadbackBuffer(2 * this.querySize) : null;
            this.queuedFrames.push(new QueuedFrame(probeReadback, timestampReadback));
        }

        // The layouts: the constants (b0) and six storage buffers (u0 .. u5) for the
        // simulation; the constants and three of the buffers read (t0 .. t2) for the display.
        // All root descriptors.
        const computeLayoutDesc = NriPipelineLayoutDesc.create();
        computeLayoutDesc.addRootConstants(0, CONSTANTS_SIZE, NriStage.Compute);
        for (let i = 0; i < BUFFERS; i++) {
            computeLayoutDesc.addRange(0, i, 1, NriDescriptorType.StorageStructuredBuffer, NriStage.Compute, NriRangeFlags.None);
        }
        this.computeLayout = device.createPipelineLayoutFromDesc(computeLayoutDesc);
        computeLayoutDesc.destroy();
        const drawLayoutDesc = NriPipelineLayoutDesc.create();
        drawLayoutDesc.addRootConstants(0, CONSTANTS_SIZE, NriStage.Pixel);
        for (let i = 0; i < 3; i++) {
            drawLayoutDesc.addRange(0, i, 1, NriDescriptorType.StructuredBuffer, NriStage.Pixel, NriRangeFlags.None);
        }
        this.drawLayout = device.createPipelineLayoutFromDesc(drawLayoutDesc);
        drawLayoutDesc.destroy();
        const computeLayout = this.computeLayout;
        const drawLayout = this.drawLayout;
        if (!computeLayout || !drawLayout) {
            console.log("Cannot create the pipeline layouts");
            return 0;
        }

        const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
        const shaders = `shaders/powder_sandbox/${folder}/powder_sandbox`;
        for (const entry of ENTRIES) {
            const pipeline = device.createComputePipelinePermutation(computeLayout, `${shaders}_${entry}.bin`, entry, "SIMULATION=1");
            if (!pipeline) {
                console.log(`Cannot load ${entry}`);
                return 0;
            }
            this.pipelines.push(pipeline);
        }
        const desc = NriPipelineDesc.create();
        let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_display_vs.bin`, "display_vs") != 0;
        if (loaded) {
            loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_display_ps.bin`, "display_ps") != 0;
        }
        desc.setCullMode(NriCullMode.None);
        desc.setColor(format, NriColorWrite.RGBA);
        if (loaded) {
            this.drawPipeline = device.createPipelineFromDesc(drawLayout, desc);
        }
        desc.destroy();
        if (!this.drawPipeline) {
            console.log("Cannot load the display shaders");
            return 0;
        }

        // The particles, the grid's int and float sections, the cells, the free list, the multigrid's
        // coarser levels (for the longest grid, either way around).
        const multigridSize = (AIR_FLOATS + Math.max(multigridFloats(MAX_GRID_LONG, DEFAULT_GRID_HEIGHT),
            multigridFloats(DEFAULT_GRID_HEIGHT, MAX_GRID_LONG))) * 4;
        const sizes = [CAPACITY * PARTICLE_SIZE, ALL_INT_SECTIONS * GRID_CAPACITY * 4, FLOAT_SECTIONS * GRID_CAPACITY * 4,
            GRID_CAPACITY * 4, (ALLOC_LIST + CAPACITY) * 4, multigridSize];
        const strides = [PARTICLE_SIZE, 4, 4, 4, 4, 4];
        for (const size of sizes) {
            this.bufferSizes.push(size);
        }
        for (const i of STATE_BUFFERS) {
            this.stateSize += sizes[i];
        }
        for (let i = 0; i < UNDO_DEPTH; i++) {
            const undoBuffer = device.createUninitializedStorageBuffer(this.queue, this.stateSize, 4, NriBufferState.CopyDestination);
            if (!undoBuffer) {
                console.log("Cannot create the undo buffers");
                return 0;
            }
            this.undoBuffers.push(undoBuffer);
            this.undoW.push(0);
            this.undoH.push(0);
        }
        for (let i = 0; i < BUFFERS; i++) {
            const buffer = device.createUninitializedStorageBuffer(this.queue, sizes[i], strides[i], NriBufferState.Storage);
            if (!buffer) {
                console.log("Cannot create the simulation's buffers");
                return 0;
            }
            this.buffers.push(buffer);
            const storageView = buffer.createStructuredView(1);
            if (!storageView) {
                console.log("Cannot create the buffer views");
                return 0;
            }
            this.storageViews.push(storageView);
            if (i >= 1 && i <= 3) {
                const shaderView = buffer.createStructuredView(0);
                if (!shaderView) {
                    console.log("Cannot create the buffer views");
                    return 0;
                }
                this.shaderViews.push(shaderView);
            }
        }
        // The simulation's set (the six storage buffers) and the display's (three of them read).
        const descriptorPool = device.createDescriptorPoolWithBuffers(2, 0, 0, 0, 0, 3, BUFFERS, 0);
        if (!descriptorPool) {
            console.log("Cannot create the descriptor pool");
            return 0;
        }
        this.descriptorPool = descriptorPool;
        const computeSet = descriptorPool.allocateDescriptorSet(computeLayout, 0, 0);
        const drawSet = descriptorPool.allocateDescriptorSet(drawLayout, 0, 0);
        if (!computeSet) {
            console.log("Cannot allocate the descriptor sets");
            return 0;
        }
        if (!drawSet) {
            console.log("Cannot allocate the descriptor sets");
            return 0;
        }
        this.computeSet = computeSet;
        this.drawSet = drawSet;
        this.kernels.bind(this.pipelines, computeSet, this.buffers);
        for (let i = 0; i < BUFFERS; i++) {
            computeSet.updateDescriptor(i, 0, this.storageViews[i]);
        }
        for (let i = 0; i < 3; i++) {
            drawSet.updateDescriptor(i, 0, this.shaderViews[i]);
        }
        if (this.test) {
            this.testReadback = device.createReadbackBuffer(ALL_INT_SECTIONS * GRID_CAPACITY * 4);
            this.cellsReadback = device.createReadbackBuffer(GRID_CAPACITY * 4);
            this.floatReadback = device.createReadbackBuffer(FLOAT_SECTIONS * GRID_CAPACITY * 4);
            const alignment = device.getUploadBufferTextureRowAlignment();
            this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
            this.frameReadback = device.createReadbackBuffer(this.rowPitch * this.height);
        }

        if (this.sample.initImgui(device) == 0) {
            console.log("Cannot initialize the user interface");
            return 0;
        }
        this.imgui = true;
        return 1;
    }

    // The swap chain's size and its views' format (rendered through UNORM views: the display
    // writes its colors as they are).
    sizeToSwapChain() {
        this.width = this.swapChain.width();
        this.height = this.swapChain.height();
        this.viewFormat = this.swapChain.viewFormat();
    }

    // The window was resized (NriSample.useResizableWindow): the swap chain made again at its size, once
    // the GPU is done with the old one, and the toolbar and the grid's view fitted to it. The grid
    // keeps its cells (and what's in them), so a window of another shape shows it with margins;
    // but when the window turns (a phone turned: wider than tall to taller than wide, or back) the
    // grid is remade to its shape, what it holds kept on its floor and centered.
    resizeIfNeeded() {
        const device = this.device;
        if (!device) {
            return;
        }
        if (!this.swapChain.resized()) {
            return;
        }
        this.swapChain.recreate();
        this.sizeToSwapChain();
        const wide = this.wantsWide() || this.width >= this.height - this.toolbarFullHeight();
        if (wide != (this.gridW >= this.gridH)) {
            const oldW = this.gridW;
            const oldH = this.gridH;
            this.fitGrid();
            this.reshaped(oldW, oldH);
        }
        this.layout();
        this.scrollToolbar(this.toolbarScroll);
    }

    // Waits for the frame that last used this frame's command allocator.
    latencySleep(frameIndex: int) {
        this.frames.wait(frameIndex);
    }

    recordDraw(commandBuffer: NriCommandBuffer) {
        const drawLayout = this.drawLayout;
        const drawPipeline = this.drawPipeline;
        if (!drawLayout || !drawPipeline) {
            return;
        }
        commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
        commandBuffer.setScissor(0, 0, this.width, this.height);
        commandBuffer.setPipelineLayout(drawLayout);
        commandBuffer.setPipeline(drawPipeline);
        this.kernels.setGraphicsConstants(commandBuffer);
        commandBuffer.setDescriptorPool(this.descriptorPool);
        commandBuffer.setDescriptorSet(0, this.drawSet);
        commandBuffer.draw(3, 1, 0, 0);
    }

    renderFrame(frameIndex: int) {
        this.resizeIfNeeded();
        this.frameIndex = frameIndex;
        const queuedFrame = this.queuedFrames[frameIndex % this.queuedFrames.length];
        const frameTime = this.test ? 1.0 / 60.0 : Math.min(this.sample.getFrameTime(), 0.25);
        this.time += frameTime;
        this.messageTime -= frameTime;
        this.fpsFrames++;
        this.fpsTime += this.sample.getFrameTime();
        if (this.fpsTime >= 0.5) {
            this.frameRate = this.fpsFrames / this.fpsTime;
            this.fpsFrames = 0;
            this.fpsTime = 0.0;
        }

        // The readout this slot's last frame wrote, and its simulation's time.
        if (frameIndex >= this.queuedFrames.length) {
            queuedFrame.probeReadback.readInts(Ref(this.probe[0]), PROBE_INTS + EVENT_COUNT);
            queuedFrame.probeReadback.readFloats(Ref(this.probeFloats[0]), PROBE_INTS);
            this.playSounds(queuedFrame.steps, frameTime);
            this.checkGoal(queuedFrame.levelTime);
        } else {
            this.probe[0] = CAPACITY;
        }
        this.readTimestamps(queuedFrame);
        this.readProfile();

        // The steps this frame's time covers; after a long frame (over two frames at 60 Hz) the
        // simulation falls behind rather than taking ever more steps.
        const step = 1.0 / (60.0 * this.substeps);
        let steps = this.substeps;
        if (!this.test) {
            this.pendingTime += frameTime;
            steps = Math.floor(this.pendingTime / step);
            if (steps > 2 * this.substeps) {
                steps = 2 * this.substeps;
                this.pendingTime = 0.0;
            } else {
                this.pendingTime -= steps * step;
            }
        }

        if (this.test && this.roundTrip) {
            this.roundTripRequests(frameIndex);
        }
        if (this.test && this.regrid != 0) {
            this.regridRequests(frameIndex);
        }
        this.qualityRequests(frameIndex);
        this.advanceLevel(this.paused ? 0 : steps, step);
        const brushMode = this.test ? 0 : this.handleInput();
        this.prepareStateRequests();
        this.fillConstants(step);
        if (this.imgui) {
            this.buildUI();
        }

        // Acquire a swap chain texture
        const index = this.swapChain.acquire(frameIndex);
        if (index >= 0) {
            const texture = this.swapChain.texture(index);
            const commandBuffer = this.frames.commandBuffer(frameIndex);

            // Record: the simulation's steps, the readout, then the grid drawn and the toolbar
            // over it.
            commandBuffer.begin();
            this.recordStateRequests(commandBuffer);
            const queryPool = this.queryPool;
            const queryBase = (frameIndex % this.queuedFrames.length) * 2;
            if (queryPool) {
                commandBuffer.resetQueries(queryPool, queryBase, 2);
                commandBuffer.writeTimestamp(queryPool, queryBase);
            }
            const profiler = this.profiler;
            if (profiler) {
                profiler.begin(commandBuffer, this.frameIndex);
            }
            this.recordSimulation(commandBuffer, brushMode, steps);
            this.recordSparks(commandBuffer, brushMode);
            this.recordGlow(commandBuffer);
            if (profiler) {
                profiler.end(commandBuffer, this.frameIndex);
            }
            queuedFrame.steps = this.paused ? 0 : steps;
            queuedFrame.levelTime = this.levelTime;
            const timestampReadback = queuedFrame.timestampReadback;
            if (queryPool) {
                commandBuffer.writeTimestamp(queryPool, queryBase + 1);
                if (timestampReadback) {
                    commandBuffer.copyQueries(queryPool, queryBase, 2, timestampReadback, 0);
                    queuedFrame.timedSteps = this.paused ? 0 : steps;
                }
            }
            this.kernels.dispatch(commandBuffer, PROBE, 1, 0);
            // (the brush's fields stand for the goal's material and box)
            const level = this.level;
            if (level && level.goalCount > 0) {
                this.kernels.setInt(8, level.goalMaterial | (level.goalLit ? GOAL_LIT : 0));
                this.kernels.setFloat(10, level.goalBox[0] * this.gridW);
                this.kernels.setFloat(11, level.goalBox[1] * this.gridH);
                this.kernels.setFloat(12, level.goalBox[2] * this.gridW);
                this.kernels.setFloat(13, level.goalBox[3] * this.gridH);
                this.kernels.dispatch(commandBuffer, GOAL, 1, 0);
                this.kernels.setInt(8, this.tool);
            }
            const alloc = this.buffers[4];
            commandBuffer.bufferBarrier(alloc, NriBufferState.Storage, NriBufferState.CopySource);
            commandBuffer.copyBuffer(queuedFrame.probeReadback, alloc, PROBE_INTS * 4);
            commandBuffer.bufferBarrier(alloc, NriBufferState.CopySource, NriBufferState.Storage);
            // (then the last step's events)
            const gridInt = this.buffers[1];
            commandBuffer.bufferBarrier(gridInt, NriBufferState.Storage, NriBufferState.CopySource);
            commandBuffer.copyBufferRegion(queuedFrame.probeReadback, PROBE_INTS * 4, gridInt, I_EVENTS * this.stride * 4,
                EVENT_COUNT * 4);
            commandBuffer.bufferBarrier(gridInt, NriBufferState.CopySource, NriBufferState.Storage);
            const testReadback = this.testReadback;
            if (testReadback) {
                if (frameIndex == this.testFrames - 1) {
                    commandBuffer.bufferBarrier(this.buffers[1], NriBufferState.Storage, NriBufferState.CopySource);
                    commandBuffer.copyBuffer(testReadback, this.buffers[1], ALL_INT_SECTIONS * this.stride * 4);
                    commandBuffer.bufferBarrier(this.buffers[1], NriBufferState.CopySource, NriBufferState.Storage);
                    const cellsReadback = this.cellsReadback;
                    if (cellsReadback) {
                        commandBuffer.bufferBarrier(this.buffers[3], NriBufferState.Storage, NriBufferState.CopySource);
                        commandBuffer.copyBuffer(cellsReadback, this.buffers[3], this.stride * 4);
                        commandBuffer.bufferBarrier(this.buffers[3], NriBufferState.CopySource, NriBufferState.Storage);
                    }
                    const floatReadback = this.floatReadback;
                    if (floatReadback) {
                        commandBuffer.bufferBarrier(this.buffers[2], NriBufferState.Storage, NriBufferState.CopySource);
                        commandBuffer.copyBuffer(floatReadback, this.buffers[2], FLOAT_SECTIONS * this.stride * 4);
                        commandBuffer.bufferBarrier(this.buffers[2], NriBufferState.CopySource, NriBufferState.Storage);
                    }
                }
            }
            const shown = B_GRID_INT | B_GRID_FLOAT | B_CELLS;
            this.kernels.barriers(commandBuffer, shown, NriBufferState.Storage, NriBufferState.PixelShaderResource);
            if (this.imgui) {
                this.sample.copyImguiData(commandBuffer);
            }
            commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
            commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
            commandBuffer.clearColor(0.0, 0.0, 0.0, 1.0);
            this.recordDraw(commandBuffer);
            if (this.imgui) {
                this.sample.drawImguiUnconverted(commandBuffer, this.viewFormat);
            }
            commandBuffer.endRendering();
            this.kernels.barriers(commandBuffer, shown, NriBufferState.PixelShaderResource, NriBufferState.Storage);
            let presentFrom = NriTextureState.ColorAttachment;
            const frameReadback = this.frameReadback;
            if (frameReadback) {
                if (frameIndex == this.testFrames - 1) {
                    commandBuffer.textureBarrier(texture, NriTextureState.ColorAttachment, NriTextureState.CopySource);
                    commandBuffer.readbackTextureToBuffer(frameReadback, this.rowPitch, texture, this.width, this.height);
                    presentFrom = NriTextureState.CopySource;
                }
            }
            commandBuffer.textureBarrier(texture, presentFrom, NriTextureState.Present);
            commandBuffer.end();

            // Submit and present
            this.swapChain.submit(commandBuffer, index);
            if (this.imgui) {
                this.sample.imguiEndFrame();
            }
            this.swapChain.present(index);
        }

        // Signaled after the present, as NRISamples do
        this.frames.signal(frameIndex);
        this.finishStateRequests();
    }

    // -test's checks (checks.ts's PowderSandbox has them): "" if they pass, else what failed.
    checkTest(): string {
        return "the test's checks aren't in this build";
    }

    destroy() {
        const audio = this.audio;
        if (audio) {
            audio.destroy();
            this.audio = null;
        }
        const device = this.device;
        if (device) {
            device.waitIdle();
            if (this.imgui) {
                this.sample.destroyImgui();
            }
            this.frames.destroy();
            for (const queuedFrame of this.queuedFrames) {
                queuedFrame.probeReadback.destroy();
                const timestampReadback = queuedFrame.timestampReadback;
                if (timestampReadback) {
                    timestampReadback.destroy();
                }
            }
            const queryPool = this.queryPool;
            if (queryPool) {
                queryPool.destroy();
            }
            const profiler = this.profiler;
            if (profiler) {
                profiler.destroy();
            }
            this.swapChain.destroy();
            for (const view of this.storageViews) {
                view.destroy();
            }
            this.descriptorPool.destroy();
            for (const view of this.shaderViews) {
                view.destroy();
            }
            for (const buffer of this.buffers) {
                buffer.destroy();
            }
            const testReadback = this.testReadback;
            if (testReadback) {
                testReadback.destroy();
            }
            const cellsReadback = this.cellsReadback;
            if (cellsReadback) {
                cellsReadback.destroy();
            }
            const floatReadback = this.floatReadback;
            if (floatReadback) {
                floatReadback.destroy();
            }
            const frameReadback = this.frameReadback;
            if (frameReadback) {
                frameReadback.destroy();
            }
            for (const pipeline of this.pipelines) {
                pipeline.destroy();
            }
            const drawPipeline = this.drawPipeline;
            if (drawPipeline) {
                drawPipeline.destroy();
            }
            const computeLayout = this.computeLayout;
            if (computeLayout) {
                computeLayout.destroy();
            }
            const drawLayout = this.drawLayout;
            if (drawLayout) {
                drawLayout.destroy();
            }
            for (const undoBuffer of this.undoBuffers) {
                undoBuffer.destroy();
            }
            device.destroy();
        }
        this.sample.destroy();
    }
}

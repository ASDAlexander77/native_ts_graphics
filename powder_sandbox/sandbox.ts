/// <reference path="../core/nri/nri_interop.d.ts" />
import { formatFixed } from "../core/text_format";
import {
    WINDOW_TITLE, CAPACITY, DEFAULT_GRID_HEIGHT, QUALITY_FRAMES, STEP_BUDGET_MS, MIN_GRID_HEIGHT,
    QUALITY_PATH, QUALITY_MAGIC, QUALITY_HEADER_INTS, MAX_GRID_LONG, GRID_CAPACITY, DRAG_THRESHOLD,
    MAX_ZOOM, STROKE_CANCEL_TIME, LONG_PRESS_TIME, PROFILE_EVERY, PROFILE_QUERIES, PROFILE_REPORT,
    MIN_BRUSH, MAX_BRUSH, MOUSE_MIDDLE, GROUP_SIZE, CONSTANTS_FLOATS, CONSTANTS_SIZE,
    PARTICLE_TYPES, SPARK_ITERATIONS, ALL_INT_SECTIONS, INT_SECTIONS, I_EVENTS, EVENT_COUNT,
    EVENT_MIN, EVENT_COOLDOWN, EVENTS_LOUD, FLOAT_SECTIONS, MAX_BODIES, ALLOC_LIST, PARTICLE_SIZE,
    PROBE_INTS, PROBE_VISCOUS, PROBE_AIR, PROBE_GOAL, GRAVITY, FLIP_RATIO, SOR_OMEGA, SOLVER_SOR,
    WATER, OIL, SAND, FIRE, LAVA, ACID, SALT, GUNPOWDER, HONEY, PETROL, WALL, GLASS, WOOD, URANIUM,
    EMITTER, ICE, METAL, FAN, BLOCK, BATTERY, LAMP, ERASE, HEAT, COOL, SALT_WATER, SPARK, C4, COAL,
    FUSE, HYDROGEN, OXYGEN, NEON, THERMITE, NITRO, SEED, CLONE, BLACK_HOLE, WHITE_HOLE, SPONGE,
    SWITCH, DETECTOR, HEATER, INSPECT, INIT_GRID, INIT_PARTICLES, CLEAR, P2G, GRID, HEAT_SOURCE,
    HEAT_DIFFUSE, DIVERGENCE, PRESSURE, PROJECT, G2P, SPAWN, PROBE, MG_SETUP, MG_SMOOTH,
    MG_RESTRICT, MG_PROLONG, MG_COARSE, VISCOSITY, AIR, BODIES, GOAL, GLOW_EMIT, GLOW_X, GLOW_Y,
    SPARKS, AIR_FLOATS, ENTRIES, B_GRID_INT, B_GRID_FLOAT, B_CELLS, B_MG, B_ALL, BUFFERS, Tile,
    ACTION_SMALLER, ACTION_LARGER, ACTION_PAUSE, ACTION_VIEW, ACTION_CLEAR, ACTION_SHAPE,
    ACTION_UNDO, ACTION_SAVE, ACTION_LOAD, ACTION_LEVEL, ACTION_GRAVITY, GRAVITY_POINT,
    GRAVITY_TILT, GRAVITY_NAMES, GRAVITY_LABELS, TILT_FLAT, STANDARD_GRAVITY, GRAVITY_PLACE,
    GOAL_LIT, STATE_BUFFERS, UNDO_DEPTH, KEY_Z, KEY_LEFT_CONTROL, KEY_RIGHT_CONTROL, VIEW_NAMES,
    SHAPE_CIRCLE, SHAPE_SQUARE, SHAPE_LINE, SHAPE_BOX, SHAPE_NAMES, levelSize, levelCount,
    multigridFloats, fanDirectionOf, sectionMaterial, materialName, starText, QueuedFrame,
    SwapChainTexture
} from "./defs";
import { SandboxSaves } from "./saves";

// The callbacks given to C++, kept for as long as it may call them.
let retainedInitializeCallbacks: NriInitializeCallback[] = [];
let retainedFrameCallbacks: NriFrameCallback[] = [];

// The sandbox: its GPU resources, simulation, toolbar and input, run with NRI (its state:
// state.ts; the grid's place on screen: view.ts; its scenes and levels: levels.ts; undo,
// save/load and regrid: saves.ts).
export class SandboxApp extends SandboxSaves {
    constructor(sample: NriSampleHandle) {
        super(sample);
        for (let i = 0; i < CONSTANTS_FLOATS; i++) {
            this.constants.push(0.0);
        }
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
        Nri_SetInitializeCallback(this.sample, initialize);
        Nri_SetLatencySleepCallback(this.sample, latencySleep);
        Nri_SetRenderFrameCallback(this.sample, renderFrame);

        let result = Nri_RunSample(this.sample, argc, argv, WINDOW_TITLE, this.testFrames);
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
        const device = Nri_CreateDevice(this.sample, graphicsAPI);
        if (!device) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 0;
        }
        this.device = device;
        console.log(`Renderer: ${Nri_GetGraphicsAPIString(graphicsAPI)} (${Nri_GetAdapterName(device)})`);

        this.queue = Nri_GetGraphicsQueue(device);
        this.frameFence = Nri_CreateFence(device, 0);
        this.test = Nri_IsTest(this.sample) != 0;
        // (a test's default scene is the U-tube, not a level's empty one)
        if (this.test && this.scene == 0 && !this.level) {
            this.scene = 1;
        }
        this.startQuality();
        if ((!this.test || this.soundCheck) && !this.mute) {
            this.audio = Nri_CreateAudio();
            console.log(this.audio ? "Sound: the audio output started" : "No sound: no audio output");
        }

        const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
        this.createSwapChain(device);
        const format = this.viewFormat;
        this.fitGrid();
        this.zoom = Math.min(Math.max(this.startZoom, 1.0), MAX_ZOOM);
        this.layout();
        this.stateW = this.gridW;
        this.stateH = this.gridH;

        // Queued frames
        const queryPool = Nri_CreateTimestampQueryPool(device, 2 * queuedFrameNum);
        this.queryPool = queryPool;
        if (queryPool) {
            this.querySize = Nri_GetQuerySize(queryPool);
        }
        // (no && with a handle: tslang can't mix one with a boolean)
        if (this.profile && this.querySize > 0) {
            this.profilePool = Nri_CreateTimestampQueryPool(device, PROFILE_QUERIES);
            this.profileReadback = Nri_CreateReadbackBuffer(device, PROFILE_QUERIES * this.querySize);
            for (let e = 0; e < ENTRIES.length; e++) {
                this.profileSums.push(0.0);
            }
        }
        for (let i = 0; i < queuedFrameNum; i++) {
            const commandAllocator = Nri_CreateCommandAllocator(this.queue);
            const probeReadback = Nri_CreateReadbackBuffer(device, (PROBE_INTS + EVENT_COUNT) * 4);
            if (!probeReadback) {
                console.log("Cannot create the readback buffers");
                return 0;
            }
            const timestampReadback = queryPool ? Nri_CreateReadbackBuffer(device, 2 * this.querySize) : null;
            this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), probeReadback,
                timestampReadback));
        }

        // The layouts: the constants (b0) and six storage buffers (u0 .. u5) for the
        // simulation; the constants and three of the buffers read (t0 .. t2) for the display.
        // All root descriptors.
        const computeLayoutDesc = Nri_CreatePipelineLayoutDesc();
        Nri_PipelineLayoutDescAddRootConstants(computeLayoutDesc, 0, CONSTANTS_SIZE, NriStage.Compute);
        for (let i = 0; i < BUFFERS; i++) {
            Nri_PipelineLayoutDescAddRange(computeLayoutDesc, 0, i, 1, NriDescriptorType.StorageStructuredBuffer, NriStage.Compute, NriRangeFlags.None);
        }
        this.computeLayout = Nri_CreatePipelineLayoutFromDesc(device, computeLayoutDesc);
        Nri_DestroyPipelineLayoutDesc(computeLayoutDesc);
        const drawLayoutDesc = Nri_CreatePipelineLayoutDesc();
        Nri_PipelineLayoutDescAddRootConstants(drawLayoutDesc, 0, CONSTANTS_SIZE, NriStage.Pixel);
        for (let i = 0; i < 3; i++) {
            Nri_PipelineLayoutDescAddRange(drawLayoutDesc, 0, i, 1, NriDescriptorType.StructuredBuffer, NriStage.Pixel, NriRangeFlags.None);
        }
        this.drawLayout = Nri_CreatePipelineLayoutFromDesc(device, drawLayoutDesc);
        Nri_DestroyPipelineLayoutDesc(drawLayoutDesc);
        const computeLayout = this.computeLayout;
        const drawLayout = this.drawLayout;
        if (!computeLayout || !drawLayout) {
            console.log("Cannot create the pipeline layouts");
            return 0;
        }

        const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
        const shaders = `shaders/powder_sandbox/${folder}/powder_sandbox`;
        for (const entry of ENTRIES) {
            const pipeline = Nri_CreateComputePipelinePermutation(device, computeLayout, `${shaders}_${entry}.bin`, entry, "SIMULATION=1");
            if (!pipeline) {
                console.log(`Cannot load ${entry}`);
                return 0;
            }
            this.pipelines.push(pipeline);
        }
        const desc = Nri_CreatePipelineDesc();
        let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_display_vs.bin`, "display_vs") != 0;
        if (loaded) {
            loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_display_ps.bin`, "display_ps") != 0;
        }
        Nri_PipelineDescSetCullMode(desc, NriCullMode.None);
        Nri_PipelineDescSetColor(desc, format, NriColorWrite.RGBA);
        if (loaded) {
            this.drawPipeline = Nri_CreatePipelineFromDesc(device, drawLayout, desc);
        }
        Nri_DestroyPipelineDesc(desc);
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
            const undoBuffer = Nri_CreateUninitializedStorageBuffer(device, this.queue, this.stateSize, 4, NriBufferState.CopyDestination);
            if (!undoBuffer) {
                console.log("Cannot create the undo buffers");
                return 0;
            }
            this.undoBuffers.push(undoBuffer);
            this.undoW.push(0);
            this.undoH.push(0);
        }
        for (let i = 0; i < BUFFERS; i++) {
            const buffer = Nri_CreateUninitializedStorageBuffer(device, this.queue, sizes[i], strides[i], NriBufferState.Storage);
            if (!buffer) {
                console.log("Cannot create the simulation's buffers");
                return 0;
            }
            this.buffers.push(buffer);
            const storageView = Nri_CreateStructuredBufferView(buffer, 1);
            if (!storageView) {
                console.log("Cannot create the buffer views");
                return 0;
            }
            this.storageViews.push(storageView);
            if (i >= 1 && i <= 3) {
                const shaderView = Nri_CreateStructuredBufferView(buffer, 0);
                if (!shaderView) {
                    console.log("Cannot create the buffer views");
                    return 0;
                }
                this.shaderViews.push(shaderView);
            }
        }
        // The simulation's set (the six storage buffers) and the display's (three of them read).
        const descriptorPool = Nri_CreateDescriptorPoolWithBuffers(device, 2, 0, 0, 0, 0, 3, BUFFERS, 0);
        if (!descriptorPool) {
            console.log("Cannot create the descriptor pool");
            return 0;
        }
        this.descriptorPool = descriptorPool;
        const computeSet = Nri_AllocateDescriptorSet(descriptorPool, computeLayout, 0, 0);
        const drawSet = Nri_AllocateDescriptorSet(descriptorPool, drawLayout, 0, 0);
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
        for (let i = 0; i < BUFFERS; i++) {
            Nri_UpdateDescriptor(computeSet, i, 0, this.storageViews[i]);
        }
        for (let i = 0; i < 3; i++) {
            Nri_UpdateDescriptor(drawSet, i, 0, this.shaderViews[i]);
        }
        if (this.test) {
            this.testReadback = Nri_CreateReadbackBuffer(device, ALL_INT_SECTIONS * GRID_CAPACITY * 4);
            this.cellsReadback = Nri_CreateReadbackBuffer(device, GRID_CAPACITY * 4);
            this.floatReadback = Nri_CreateReadbackBuffer(device, FLOAT_SECTIONS * GRID_CAPACITY * 4);
            const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
            this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
            this.frameReadback = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
        }

        if (Nri_InitImgui(this.sample, device) == 0) {
            console.log("Cannot initialize the user interface");
            return 0;
        }
        this.imgui = true;
        return 1;
    }

    // The swap chain at the window's size, rendered through UNORM views (the display writes its
    // colors as they are), its textures' views and semaphores.
    createSwapChain(device: NriDeviceHandle) {
        this.width = Nri_GetOutputWidth(this.sample);
        this.height = Nri_GetOutputHeight(this.sample);
        this.swapChain = Nri_CreateSwapChain(this.sample, device, this.queue, Nri_GetQueuedFrameNum(this.sample) + 1);
        const textureNum = Nri_GetSwapChainTextureNum(this.swapChain);
        const format = Nri_GetTextureFormat(Nri_GetSwapChainTexture(this.swapChain, 0));
        this.viewFormat = format;
        for (let i = 0; i < textureNum; i++) {
            const texture = Nri_GetSwapChainTexture(this.swapChain, i);
            this.swapChainTextures.push(new SwapChainTexture(texture, Nri_CreateColorAttachmentView(texture, format),
                Nri_CreateSwapChainSemaphore(device), Nri_CreateSwapChainSemaphore(device)));
        }
    }

    destroySwapChain() {
        for (const swapChainTexture of this.swapChainTextures) {
            Nri_DestroyFence(swapChainTexture.acquireSemaphore);
            Nri_DestroyFence(swapChainTexture.releaseSemaphore);
            Nri_DestroyDescriptor(swapChainTexture.colorAttachment);
        }
        this.swapChainTextures = [];
        Nri_DestroySwapChain(this.swapChain);
    }

    // The window was resized (Nri_UseResizableWindow): the swap chain made again at its size, once
    // the GPU is done with the old one, and the toolbar and the grid's view fitted to it. The grid
    // keeps its cells (and what's in them), so a window of another shape shows it with margins;
    // but when the window turns (a phone turned: wider than tall to taller than wide, or back) the
    // grid is remade to its shape, what it holds kept on its floor and centered.
    resizeIfNeeded() {
        const device = this.device;
        if (!device) {
            return;
        }
        if (Nri_GetOutputWidth(this.sample) == this.width && Nri_GetOutputHeight(this.sample) == this.height) {
            return;
        }
        Nri_DeviceWaitIdle(device);
        this.destroySwapChain();
        this.createSwapChain(device);
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

    // A tile for a group's row (and the list of every tile).
    addTile(group: int, tile: Tile) {
        tile.group = group;
        this.tiles.push(tile);
    }

    // The group whose tiles the toolbar shows; its row scrolled back to its start.
    showGroup(group: int) {
        this.group = group;
        this.groupTiles = [];
        for (const tile of this.tiles) {
            if (tile.group == group) {
                this.groupTiles.push(tile);
            }
        }
        this.toolbarScroll = 0.0;
        this.layout();
    }

    // Waits for the frame that last used this frame's command allocator.
    latencySleep(frameIndex: int) {
        const queuedFrameNum = this.queuedFrames.length;
        const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
        Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
        Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
    }

    // How far the tiles' row scrolls.
    maxScroll(): number {
        return Math.max(this.groupTiles.length * this.tileWidth - this.width, 0.0);
    }

    scrollToolbar(scroll: number) {
        this.toolbarScroll = Math.min(Math.max(scroll, 0.0), this.maxScroll());
    }

    // How far the tabs' row scrolls.
    maxTabScroll(): number {
        return Math.max(this.tabEnd - this.width, 0.0);
    }

    scrollTabs(scroll: number) {
        this.tabScroll = Math.min(Math.max(scroll, 0.0), this.maxTabScroll());
    }

    // Whether y is on the tabs' row (else the tiles', on the toolbar).
    onTabRow(y: number): boolean {
        return y < this.height - this.tileHeight;
    }

    // The size slider shows while the brush is sized by its radius (a circle, a square, a line's
    // half width; not a box, the size it's stretched to), along the top, sliderHeight() tall.
    sliderShown(): boolean {
        return this.brushShape != SHAPE_BOX;
    }

    sliderTop(): number {
        return 6.0;
    }

    sliderHeight(): number {
        return this.tabHeight;
    }

    onSlider(x: number, y: number): boolean {
        return this.sliderShown() && y >= this.sliderTop() && y < this.sliderTop() + this.sliderHeight() && x >= this.sliderX0 - this.sliderHeight()
            && x <= this.sliderX1 + this.sliderHeight();
    }

    // The brush's radius from x along the slider's track (whole cells, or the smallest).
    slideBrush(x: number) {
        const t = Math.min(Math.max((x - this.sliderX0) / Math.max(this.sliderX1 - this.sliderX0, 1.0), 0.0), 1.0);
        const radius = Math.round(MIN_BRUSH + t * (MAX_BRUSH - MIN_BRUSH));
        this.brushRadius = radius < 1.0 ? MIN_BRUSH : radius;
    }

    // The menu's icons: their half size, and how far their centers are from the menu's.
    menuIconHalf(): number {
        return Math.floor(this.tileHeight * 0.42);
    }

    menuRadius(): number {
        return Math.floor(this.tileHeight * 1.15);
    }

    // Icon k's center: around the menu's, up, right, down, left.
    menuIconX(k: int): number {
        return this.menuX + (k == 1 ? this.menuRadius() : (k == 3 ? -this.menuRadius() : 0.0));
    }

    menuIconY(k: int): number {
        return this.menuY + (k == 0 ? -this.menuRadius() : (k == 2 ? this.menuRadius() : 0.0));
    }

    // The icon at (x, y), or -1.
    menuIconAt(x: number, y: number): int {
        const half = this.menuIconHalf();
        for (let k = 0; k < SHAPE_NAMES.length; k++) {
            if (Math.abs(x - this.menuIconX(k)) <= half && Math.abs(y - this.menuIconY(k)) <= half) {
                return k;
            }
        }
        return -1;
    }

    // The menu, opened around (x, y), kept where its icons fit above the toolbar.
    openMenu(x: number, y: number) {
        const reach = this.menuRadius() + this.menuIconHalf() + 4.0;
        const playHeight = this.height - this.toolbarHeight;
        this.menuX = Math.min(Math.max(x, reach), Math.max(this.width - reach, reach));
        this.menuY = Math.min(Math.max(y, reach), Math.max(playHeight - reach, reach));
        this.menuOpen = true;
    }

    // A toolbar tile was tapped.
    onTile(tile: Tile) {
        const action = tile.tool;
        if (action == ACTION_SMALLER) {
            this.brushRadius = Math.max(this.brushRadius - 1.0, MIN_BRUSH);
        } else if (action == ACTION_LARGER) {
            this.brushRadius = Math.min(this.brushRadius + 1.0, MAX_BRUSH);
        } else if (action == ACTION_PAUSE) {
            this.paused = !this.paused;
        } else if (action == ACTION_VIEW) {
            this.overlay = (this.overlay + 1) % 3;
        } else if (action == ACTION_CLEAR) {
            this.snapshotRequested = true;
            this.needsInit = true;
        } else if (action == ACTION_UNDO) {
            this.undoRequested = true;
        } else if (action == ACTION_SAVE) {
            this.saveRequested = true;
        } else if (action == ACTION_LOAD) {
            this.loadRequested = true;
        } else if (action == ACTION_LEVEL) {
            this.nextLevel();
        } else if (action == ACTION_SHAPE) {
            this.brushShape = (this.brushShape + 1) % SHAPE_NAMES.length;
        } else if (action == ACTION_GRAVITY) {
            this.gravityMode = (this.gravityMode + 1) % GRAVITY_NAMES.length;
            // (toward a point: a tap on the grid moves it, till another tool's picked)
            if (this.gravityMode == GRAVITY_POINT) {
                this.toolBeforePlace = this.tool;
                this.tool = GRAVITY_PLACE;
            } else if (this.tool == GRAVITY_PLACE) {
                this.tool = this.toolBeforePlace;
            }
            this.showMessage(`Gravity: ${GRAVITY_NAMES[this.gravityMode]}`);
        } else {
            this.tool = action;
            // Emitters emit the liquid, powder or fire picked last.
            if (action == WATER || action == OIL || action == SAND || action == SALT || action == GUNPOWDER || action == LAVA
                || action == ACID || action == HONEY || action == PETROL || action == FIRE || action == NITRO || action == THERMITE
                || action == HYDROGEN || action == OXYGEN || action == NEON || action == SEED) {
                this.emitType = action;
            }
        }
    }

    // The pointer (mouse or touch): taps on the toolbar, strokes of the brush on the grid. The
    // brush's constants for this frame.
    handleInput(): int {
        const mx = Nri_GetMouseX(this.sample);
        const my = Nri_GetMouseY(this.sample);
        // The middle button (two fingers on Android) pans and zooms the view; the left one
        // doesn't paint meanwhile.
        const middle = Nri_IsButtonPressed(this.sample, MOUSE_MIDDLE) != 0;
        const down = Nri_IsButtonPressed(this.sample, 0) != 0 && !middle;
        const control = Nri_IsKeyPressed(this.sample, KEY_LEFT_CONTROL) != 0 || Nri_IsKeyPressed(this.sample, KEY_RIGHT_CONTROL) != 0;
        const overToolbar = my >= this.height - this.toolbarHeight;

        // Two fingers down (or the middle button): if the first finger has only just begun a
        // stroke, it was the start of a pinch, so what it painted is taken back. Then the view
        // follows the pointer (the fingers' midpoint).
        if (middle && !this.middleWasDown) {
            if (this.wasDown && !this.pressOnToolbar && this.tool != INSPECT && this.time - this.pressTime < STROKE_CANCEL_TIME) {
                this.undoRequested = true;
            }
            this.panX = mx;
            this.panY = my;
        }
        if (middle) {
            this.centerX -= (mx - this.panX) / this.cellPixels;
            this.centerY -= (my - this.panY) / this.cellPixels;
            this.panX = mx;
            this.panY = my;
            this.layout();
        }

        // The wheel over the toolbar scrolls it (half a tile a notch); over the grid it zooms
        // (with Control, or the middle button down: a pinch), or sizes the brush.
        const wheel = Nri_GetMouseWheel(this.sample);
        if (overToolbar && wheel != 0.0 && this.onTabRow(my)) {
            this.scrollTabs(this.tabScroll + (wheel > 0.0 ? -0.5 : 0.5) * this.tileWidth);
        } else if (overToolbar && wheel != 0.0) {
            this.scrollToolbar(this.toolbarScroll + (wheel > 0.0 ? -0.5 : 0.5) * this.tileWidth);
        } else if (wheel != 0.0 && (middle || control)) {
            this.zoomAt(mx, my, wheel);
        } else if (wheel > 0.0) {
            this.brushRadius = Math.min(this.brushRadius + 1.0, MAX_BRUSH);
        } else if (wheel < 0.0) {
            this.brushRadius = Math.max(this.brushRadius - 1.0, MIN_BRUSH);
        }
        this.middleWasDown = middle;
        const gx = (mx - this.viewX) / this.cellPixels;
        const gy = (my - this.viewY) / this.cellPixels;
        this.mouseGridX = gx;
        this.mouseGridY = gy;
        if (Nri_IsKeyToggled(this.sample, NriKey.Space) != 0) {
            this.paused = !this.paused;
        }
        // Ctrl+Z (each press of Z while Control is down).
        const z = Nri_IsKeyPressed(this.sample, KEY_Z) != 0;
        if (control && z && !this.zWasDown) {
            this.undoRequested = true;
        }
        this.zWasDown = z;

        let brushMode = 0;
        // (placing the attraction point paints nothing either)
        const placing = this.tool == GRAVITY_PLACE;
        if (placing && down && !this.pressOnToolbar && !(down && !this.wasDown && overToolbar)) {
            this.gravityX = Math.min(Math.max(gx, 1.0), this.gridW - 1.0);
            this.gravityY = Math.min(Math.max(gy, 1.0), this.gridH - 1.0);
        }
        const inspecting = this.tool == INSPECT || placing;
        if (down && !this.wasDown) {
            this.pressOnToolbar = overToolbar;
            this.pressTime = this.time;
            // (a press while the menu's open picks from it, or closes it; one on the slider sizes
            // the brush)
            this.longPressed = false;
            this.pressOnSlider = !overToolbar && !this.menuOpen && this.onSlider(mx, my);
            this.pressOnUi = !overToolbar && (this.menuOpen || this.pressOnSlider);
            // A stroke begins: what it changes can be undone.
            if (!overToolbar && !this.pressOnUi && !inspecting) {
                this.snapshotRequested = true;
            }
            this.pressX = mx;
            this.pressY = my;
            this.pressScroll = this.onTabRow(my) ? this.tabScroll : this.toolbarScroll;
            this.dragging = false;
            this.lastGridX = gx;
            this.lastGridY = gy;
            this.anchorX = gx;
            this.anchorY = gy;
        }
        // On the toolbar: a drag scrolls the row pressed, a release that didn't drag taps the tab
        // or the tile there.
        if (this.pressOnToolbar) {
            const tabs = this.onTabRow(this.pressY);
            if (down) {
                if (Math.abs(mx - this.pressX) > DRAG_THRESHOLD) {
                    this.dragging = true;
                }
                if (this.dragging && tabs) {
                    this.scrollTabs(this.pressScroll - (mx - this.pressX));
                } else if (this.dragging) {
                    this.scrollToolbar(this.pressScroll - (mx - this.pressX));
                }
            } else if (this.wasDown && !this.dragging && tabs) {
                const x = this.pressX + this.tabScroll;
                for (let g = 0; g < this.tabX.length; g++) {
                    if (x >= this.tabX[g] && x < (g + 1 < this.tabX.length ? this.tabX[g + 1] : this.tabEnd)) {
                        this.showGroup(g);
                    }
                }
            } else if (this.wasDown && !this.dragging) {
                const index: int = Math.floor((this.pressX + this.toolbarScroll) / this.tileWidth);
                if (index >= 0 && index < this.groupTiles.length) {
                    this.onTile(this.groupTiles[index]);
                }
            }
        }
        // The slider: the brush's radius follows the pointer along it.
        if (down && this.pressOnSlider) {
            this.slideBrush(mx);
        }
        // A press held still on the grid opens the menu around it (and takes back what it
        // painted); it's then the menu's. Not while inspecting or placing the attraction point:
        // they have no brush, and holding still is how a cell is read.
        if (down && !this.pressOnToolbar && !this.pressOnUi && !inspecting) {
            if (Math.abs(mx - this.pressX) > DRAG_THRESHOLD || Math.abs(my - this.pressY) > DRAG_THRESHOLD) {
                this.pressTime = -1.0;
            }
            if (this.pressTime >= 0.0 && this.time - this.pressTime >= LONG_PRESS_TIME) {
                this.undoRequested = true;
                this.openMenu(this.pressX, this.pressY);
                this.longPressed = true;
                this.pressOnUi = true;
            }
        }
        // Released on an icon: its shape. The press that opened the menu leaves it open when
        // released elsewhere (to tap an icon next); another closes it.
        if (!down && this.wasDown && this.menuOpen && this.pressOnUi) {
            const icon = this.menuIconAt(mx, my);
            if (icon >= 0) {
                this.brushShape = icon;
                this.menuOpen = false;
            } else if (!this.longPressed) {
                this.menuOpen = false;
            }
        }
        const toGrid = !this.pressOnToolbar && !this.pressOnUi;

        // On the grid: circles and squares paint along the path; lines and boxes when released.
        // (a Block is always a box: a body of that size)
        const boxing = this.brushShape == SHAPE_BOX || this.tool == BLOCK;
        const stretches = this.brushShape == SHAPE_LINE || boxing;
        const pressOnGrid = this.wasDown && toGrid;
        if (inspecting) {
            // (nothing painted)
        } else if (down && toGrid && !stretches) {
            brushMode = 1;
            this.fanDirection = fanDirectionOf(gx - this.anchorX, gy - this.anchorY);
            this.setFloat(10, this.lastGridX);
            this.setFloat(11, this.lastGridY);
            this.setFloat(12, gx);
            this.setFloat(13, gy);
            this.lastGridX = gx;
            this.lastGridY = gy;
        } else if (!down && pressOnGrid && stretches && !middle) {
            brushMode = boxing ? 2 : 1;
            this.fanDirection = fanDirectionOf(gx - this.anchorX, gy - this.anchorY);
            this.setFloat(10, this.anchorX);
            this.setFloat(11, this.anchorY);
            this.setFloat(12, gx);
            this.setFloat(13, gy);
        }

        // The cursor: the brush at the pointer, or the line or box being stretched; none over
        // the toolbar or while dragging it.
        let cursorMode = 1;
        let cursorX = gx;
        let cursorY = gy;
        if (down && toGrid && stretches) {
            cursorMode = boxing ? 2 : 1;
            cursorX = this.anchorX;
            cursorY = this.anchorY;
        } else if (this.brushShape == SHAPE_BOX) {
            cursorMode = 2;
        }
        if (inspecting) {
            cursorMode = 3;
        }
        if (overToolbar || (down && !toGrid) || middle || this.menuOpen || this.onSlider(mx, my)) {
            cursorMode = 0;
        }
        const shape = this.brushShape == SHAPE_SQUARE ? 1 : 0;
        this.shapeWord = shape | (cursorMode << 4);
        this.setFloat(28, cursorX);
        this.setFloat(29, cursorY);
        this.wasDown = down;
        return brushMode;
    }

    // The constants every entry sees this frame (substep, parity and the brush are set per dispatch).
    fillConstants(dt: number) {
        this.setInt(0, this.gridW);
        this.setInt(1, this.gridH);
        this.setInt(2, this.stride);
        this.setInt(3, CAPACITY);
        this.setFloat(4, dt);
        this.setFloat(5, GRAVITY);
        this.setInt(6, this.frameIndex);
        this.setInt(8, this.tool);
        this.setFloat(14, this.brushRadius);
        this.setInt(15, this.tool == FAN ? this.fanDirection : this.emitType);
        this.setFloat(17, FLIP_RATIO);
        this.setInt(18, this.overlay);
        this.setFloat(19, this.time);
        this.setFloat(20, this.viewX);
        this.setFloat(21, this.viewY);
        this.setFloat(22, this.cellPixels);
        this.setInt(23, this.scene);
        // (multigrid smooths level 0 with pressure_cs too, not over-relaxed)
        this.setFloat(24, this.solver == SOLVER_SOR ? SOR_OMEGA : 1.0);
        this.setFloat(25, this.mouseGridX);
        this.setFloat(26, this.mouseGridY);
        this.setInt(27, this.shapeWord | (this.gravityMode << 8));
        // (tilted: the gravity's direction instead of the point)
        const tilted = this.gravityMode == GRAVITY_TILT;
        if (tilted && !this.tiltFixed) {
            this.readTilt();
        } else {
            Nri_GetGravity(0, Ref(this.sensed[0]));
        }
        this.setFloat(30, tilted ? this.tiltX : this.gravityPointX());
        this.setFloat(31, tilted ? this.tiltY : this.gravityPointY());
    }

    // The phone's down across the screen (the grid's axes are the window's), from its gravity
    // sensor; kept while it lies flat (under TILT_FLAT g across the screen) or there's no reading.
    readTilt() {
        if (Nri_GetGravity(1, Ref(this.sensed[0])) == 0) {
            return;
        }
        const x = this.sensed[0];
        const y = this.sensed[1];
        const across = Math.sqrt(x * x + y * y);
        if (across > TILT_FLAT * STANDARD_GRAVITY) {
            this.tiltX = x / across;
            this.tiltY = y / across;
        }
    }

    // -tilt x y: the tilted gravity's direction, instead of the sensor's.
    setTilt(x: number, y: number) {
        const length = Math.sqrt(x * x + y * y);
        if (length > 0.0) {
            this.tiltX = x / length;
            this.tiltY = y / length;
            this.tiltFixed = true;
        }
    }

    // -profile: this frame's dispatches timed, if it's one to time (and the last one's were read).
    beginProfile(commandBuffer: NriCommandBufferHandle) {
        const profilePool = this.profilePool;
        if (!profilePool || this.profileFrame >= 0 || this.frameIndex % PROFILE_EVERY != 0) {
            return;
        }
        Nri_CmdResetQueries(commandBuffer, profilePool, 0, PROFILE_QUERIES);
        Nri_CmdWriteTimestamp(commandBuffer, profilePool, 0);
        this.profileEntries = [];
        this.profiling = true;
    }

    endProfile(commandBuffer: NriCommandBufferHandle) {
        const profilePool = this.profilePool;
        const profileReadback = this.profileReadback;
        if (!this.profiling || !profilePool || !profileReadback) {
            return;
        }
        this.profiling = false;
        Nri_CmdCopyQueries(commandBuffer, profilePool, 0, this.profileEntries.length + 1, profileReadback, 0);
        this.profileFrame = this.frameIndex;
    }

    // The timed frame's intervals, once the GPU's done with it (its queued frame's slot back), into
    // the sums; every PROFILE_REPORT frames, the report.
    readProfile() {
        const device = this.device;
        const profileReadback = this.profileReadback;
        if (!device || !profileReadback || this.profileFrame < 0 || this.frameIndex - this.profileFrame < this.queuedFrames.length) {
            return;
        }
        this.profileFrame = -1;
        for (let i = 0; i < this.profileEntries.length; i++) {
            const ms = Nri_ReadTimestampIntervalMs(device, profileReadback, i * this.querySize, (i + 1) * this.querySize);
            if (ms >= 0.0) {
                this.profileSums[this.profileEntries[i]] += ms;
            }
        }
        this.profileFrames++;
        if (this.profileFrames < PROFILE_REPORT) {
            return;
        }
        let total = 0.0;
        for (const sum of this.profileSums) {
            total += sum;
        }
        let report = `Profile (${this.gridW} x ${this.gridH}, ${CAPACITY - this.probe[0]} particles): ${formatFixed(total / this.profileFrames, 2)} ms a frame;`;
        const shown: boolean[] = [];
        for (let e = 0; e < ENTRIES.length; e++) {
            shown.push(false);
        }
        for (let n = 0; n < 12; n++) {
            let best = -1;
            for (let e = 0; e < ENTRIES.length; e++) {
                if (!shown[e] && (best < 0 || this.profileSums[e] > this.profileSums[best])) {
                    best = e;
                }
            }
            if (best < 0 || this.profileSums[best] <= 0.0) {
                break;
            }
            shown[best] = true;
            report = `${report} ${ENTRIES[best]} ${formatFixed(this.profileSums[best] / this.profileFrames, 2)}`;
        }
        console.log(report);
        for (let e = 0; e < ENTRIES.length; e++) {
            this.profileSums[e] = 0.0;
        }
        this.profileFrames = 0;
    }

    // Electricity, while running: spark_cs's iterations (each one's parity in the substep), with the
    // brush (the Spark tool's).
    recordSparks(commandBuffer: NriCommandBufferHandle, pointerBrush: int) {
        // (a scene's stroke this frame, or the pointer's)
        const brushMode = Math.max(pointerBrush, this.strokeBrush);
        if (!this.computeLayout || this.paused) {
            return;
        }
        const cells = this.gridW * this.gridH;
        this.setInt(9, brushMode);
        for (let k = 0; k < SPARK_ITERATIONS; k++) {
            this.setInt(7, k);
            this.dispatch(commandBuffer, SPARKS, cells, B_GRID_INT);
        }
        this.setInt(9, 0);
    }

    // The glow, from the frame's last step: the cells' light, blurred along x then y.
    recordGlow(commandBuffer: NriCommandBufferHandle) {
        if (!this.computeLayout) {
            return;
        }
        const cells = this.gridW * this.gridH;
        this.dispatch(commandBuffer, GLOW_EMIT, cells, B_GRID_INT);
        this.dispatch(commandBuffer, GLOW_X, cells, B_GRID_INT);
        this.dispatch(commandBuffer, GLOW_Y, cells, B_GRID_INT);
    }

    // steps: the simulation's fixed steps this frame (0 when the frame took less than one).
    recordSimulation(commandBuffer: NriCommandBufferHandle, brushMode: int, steps: int) {
        const computeLayout = this.computeLayout;
        if (!computeLayout) {
            return;
        }
        const cells = this.gridW * this.gridH;
        Nri_CmdSetDescriptorPool(commandBuffer, this.descriptorPool);
        Nri_CmdSetComputePipelineLayout(commandBuffer, computeLayout);
        if (this.needsInit) {
            this.dispatch(commandBuffer, INIT_GRID, this.stride, B_ALL);
            this.dispatch(commandBuffer, INIT_PARTICLES, CAPACITY, B_ALL);
            this.needsInit = false;
            if (this.sceneOnClear) {
                this.buildScene();
            } else {
                this.script = [];
            }
        }
        // The scene's strokes, one a frame while the pointer isn't painting.
        this.strokeBrush = 0;
        if (brushMode == 0 && this.script.length > 0) {
            const stroke = this.script[0];
            this.script.splice(0, 1);
            brushMode = 2;
            this.strokeBrush = 2;
            this.setInt(8, stroke.tool);
            this.setFloat(10, stroke.x0);
            this.setFloat(11, stroke.y0);
            this.setFloat(12, stroke.x1);
            this.setFloat(13, stroke.y1);
            this.setInt(15, stroke.emit);
        }

        if (this.paused || (steps == 0 && brushMode != 0)) {
            // Painting still works (paused, or between steps): the counts, then the brush.
            this.setInt(7, 0);
            this.setInt(9, brushMode);
            this.dispatch(commandBuffer, CLEAR, this.stride * INT_SECTIONS, B_ALL);
            this.dispatch(commandBuffer, P2G, CAPACITY, B_ALL);
            this.dispatch(commandBuffer, SPAWN, cells, B_ALL);
            return;
        }
        for (let s = 0; s < steps; s++) {
            this.setInt(7, s);
            this.setInt(9, s == 0 ? brushMode : 0);
            this.dispatch(commandBuffer, CLEAR, this.stride * INT_SECTIONS, B_ALL);
            this.dispatch(commandBuffer, P2G, CAPACITY, B_ALL);
            this.dispatch(commandBuffer, GRID, this.stride, B_ALL);
            // (only with viscous particles, as the readout a frame or two late says)
            const viscousSweeps = this.probe[PROBE_VISCOUS] != 0 ? this.viscositySweeps : 0;
            for (let k = 0; k < viscousSweeps; k++) {
                for (let parity = 0; parity < 2; parity++) {
                    this.setInt(16, parity);
                    this.dispatch(commandBuffer, VISCOSITY, this.stride, B_GRID_FLOAT);
                }
            }
            // The air once a frame, over its steps.
            if (this.air && s == steps - 1) {
                this.setInt(16, steps);
                this.dispatch(commandBuffer, AIR, 1, B_ALL);
            }
            this.dispatch(commandBuffer, HEAT_SOURCE, cells, B_ALL);
            this.dispatch(commandBuffer, HEAT_DIFFUSE, cells, B_ALL);
            this.dispatch(commandBuffer, DIVERGENCE, cells, B_ALL);
            this.recordPressure(commandBuffer);
            this.dispatch(commandBuffer, PROJECT, this.stride, B_ALL);
            if (this.bodies) {
                this.dispatch(commandBuffer, BODIES, MAX_BODIES * GROUP_SIZE, B_ALL);
            }
            this.dispatch(commandBuffer, G2P, CAPACITY, B_ALL);
            this.dispatch(commandBuffer, SPAWN, cells, B_ALL);
        }
    }

    // The pressure equation solved (F_P, from the last step's): SOR's sweeps, or multigrid's
    // V-cycles (its levels' types and faces set up from level 0's first).
    recordPressure(commandBuffer: NriCommandBufferHandle) {
        const cells = this.gridW * this.gridH;
        if (this.solver == SOLVER_SOR) {
            for (let i = 0; i < this.iterations; i++) {
                this.setInt(16, 0);
                this.dispatch(commandBuffer, PRESSURE, cells, B_GRID_FLOAT);
                this.setInt(16, 1);
                this.dispatch(commandBuffer, PRESSURE, cells, B_GRID_FLOAT);
            }
            return;
        }
        const levels = levelCount(this.gridW, this.gridH);
        for (let l = 1; l < levels; l++) {
            const w = levelSize(this.gridW, l);
            const h = levelSize(this.gridH, l);
            this.setInt(16, l << 8);
            this.dispatch(commandBuffer, MG_SETUP, (w + 1) * (h + 1), B_MG);
        }
        for (let v = 0; v < this.vcycles; v++) {
            for (let l = 0; l < levels - 1; l++) {
                this.recordSmooth(commandBuffer, l);
                this.setInt(16, l << 8);
                this.dispatch(commandBuffer, MG_RESTRICT, levelSize(this.gridW, l + 1) * levelSize(this.gridH, l + 1), B_MG);
            }
            this.setInt(16, (levels - 1) << 8);
            this.dispatch(commandBuffer, MG_COARSE, 1, B_MG);
            for (let l = levels - 2; l >= 0; l--) {
                this.setInt(16, l << 8);
                this.dispatch(commandBuffer, MG_PROLONG, levelSize(this.gridW, l) * levelSize(this.gridH, l),
                    l == 0 ? B_GRID_FLOAT : B_MG);
                this.recordSmooth(commandBuffer, l);
            }
        }
    }

    // -smooth red-black sweeps of a multigrid level (level 0's by pressure_cs).
    recordSmooth(commandBuffer: NriCommandBufferHandle, level: int) {
        const count = levelSize(this.gridW, level) * levelSize(this.gridH, level);
        for (let i = 0; i < this.smooth; i++) {
            for (let parity = 0; parity < 2; parity++) {
                this.setInt(16, parity | (level << 8));
                if (level == 0) {
                    this.dispatch(commandBuffer, PRESSURE, count, B_GRID_FLOAT);
                } else {
                    this.dispatch(commandBuffer, MG_SMOOTH, count, B_MG);
                }
            }
        }
    }

    // Auto quality, once (not in tests, but for -stepBudget): the GPU's step time measured on the
    // U-tube's water, the grid's size chosen from it and cached in QUALITY_PATH; or the cached size.
    startQuality() {
        // (unset: auto, but in a test fixed, unless it gives a budget to measure against)
        const mode = this.quality != "" ? this.quality : (this.test && this.stepBudget == STEP_BUDGET_MS ? "fixed" : "auto");
        if (mode == "fixed" || this.gridHeightSet) {
            return;
        }
        if (mode != "calibrate" && !(this.test && this.quality == "")) {
            const cached = this.readCachedHeight();
            if (cached > 0) {
                this.gridHeight = cached;
                console.log(`Auto quality: the grid's ${cached} cells high (${QUALITY_PATH})`);
                return;
            }
        }
        this.calibrating = true;
        this.calibrationScene = this.scene;
        this.calibrationLevel = this.level;
        this.level = null;
        this.scene = 1;
        this.showMessage("Measuring the GPU...");
    }

    // The grid height QUALITY_PATH holds, or 0.
    readCachedHeight(): int {
        const file = Nri_LoadFile(QUALITY_PATH);
        if (!file) {
            return 0;
        }
        const bytes: int[] = [];
        for (let i = 0; i < QUALITY_HEADER_INTS * 4; i++) {
            bytes.push(0);
        }
        Nri_CopyFileBytes(file, 0, bytes.length, Ref(bytes[0]));
        Nri_DestroyFile(file);
        const ints: int[] = [];
        for (let i = 0; i < QUALITY_HEADER_INTS; i++) {
            ints.push(bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24));
        }
        if (ints[0] != QUALITY_MAGIC || ints[1] < MIN_GRID_HEIGHT || ints[1] > DEFAULT_GRID_HEIGHT) {
            return 0;
        }
        return ints[1];
    }

    // While calibrating: the step time summed over QUALITY_FRAMES, then the grid's size from its mean
    // (smaller when over the budget), cached, and the session begun at it.
    qualityRequests(frameIndex: int) {
        if (!this.calibrating) {
            return;
        }
        if (frameIndex >= QUALITY_FRAMES[0] && this.stepMs > 0.0) {
            this.qualitySum += this.stepMs;
            this.qualityCount++;
        }
        if (frameIndex < QUALITY_FRAMES[1]) {
            return;
        }
        this.calibrating = false;
        const mean = this.qualityCount > 0 ? this.qualitySum / this.qualityCount : 0.0;
        if (mean > this.stepBudget) {
            this.gridHeight = Math.max(Math.min(Math.floor(this.gridHeight * Math.sqrt(this.stepBudget / mean) / 8) * 8,
                this.gridHeight), MIN_GRID_HEIGHT);
        }
        this.fitGrid();
        this.layout();
        console.log(`Auto quality: ${formatFixed(mean, 3)} ms a step (budget ${formatFixed(this.stepBudget, 2)}): the grid ${this.gridW} x ${this.gridH}`);
        // (a test's kept only when it asked for auto quality)
        if ((!this.test || this.quality != "") && this.queuedFrames.length > 0) {
            const header: int[] = [QUALITY_MAGIC, this.gridHeight];
            Nri_SaveBufferToFile(this.queuedFrames[0].probeReadback, 0, Ref(header[0]), QUALITY_HEADER_INTS, QUALITY_PATH);
        }
        // The session, begun at that size.
        this.scene = this.calibrationScene;
        this.level = this.calibrationLevel;
        this.script = [];
        this.sceneOnClear = true;
        this.needsInit = true;
        this.messageTime = 0.0;
    }

    // The toolbar and the readout.
    buildUI() {
        Nri_ImguiNewFrame(this.sample);
        const tileWidth = this.tileWidth;
        const pad = Math.max(2.0, Math.min(tileWidth, this.tileHeight) * 0.06);
        const labelHeight = Nri_ImguiGetFontSize() + 4.0;
        const tabTop = this.height - this.toolbarHeight;
        const top = tabTop + this.tabHeight;
        const bottom = this.height;
        Nri_ImguiDrawRect(0.0, tabTop, this.width, top, 0.13, 0.13, 0.16, 1.0);
        Nri_ImguiDrawRect(0.0, top, this.width, bottom, 0.08, 0.08, 0.1, 1.0);
        // The tabs: each as wide as its label and a gap, spread over the row when they fit; the
        // group shown lit as a selected tile is, and under a tab whose group holds the tool, a bar of the tool's color.
        const tabGap = Nri_ImguiCalcTextWidth("  ");
        let tabsWidth = 0.0;
        for (const name of this.groups) {
            tabsWidth += Nri_ImguiCalcTextWidth(name) + tabGap;
        }
        const spread = tabsWidth < this.width ? (this.width - tabsWidth) / this.groups.length : 0.0;
        this.tabX = [];
        let tabEdge = 0.0;
        for (let g = 0; g < this.groups.length; g++) {
            this.tabX.push(tabEdge);
            tabEdge += Nri_ImguiCalcTextWidth(this.groups[g]) + tabGap + spread;
        }
        this.tabEnd = tabEdge;
        this.scrollTabs(this.tabScroll);
        for (let g = 0; g < this.groups.length; g++) {
            const x0 = this.tabX[g] - this.tabScroll;
            const x1 = (g + 1 < this.groups.length ? this.tabX[g + 1] : this.tabEnd) - this.tabScroll;
            if (x1 <= 0.0 || x0 >= this.width) {
                continue;
            }
            const shown = g == this.group;
            if (shown) {
                Nri_ImguiDrawRect(x0 + 1.0, tabTop + 1.0, x1 - 1.0, top, 0.95, 0.95, 0.95, 1.0);
            }
            for (const tile of this.tiles) {
                if (tile.group == g && tile.tool == this.tool) {
                    Nri_ImguiDrawRect(x0 + pad, top - 4.0, x1 - pad, top - 1.0, tile.r, tile.g, tile.b, 1.0);
                }
            }
            const name = this.groups[g];
            const gray = shown ? 0.0 : 0.65;
            Nri_ImguiDrawText((x0 + x1 - Nri_ImguiCalcTextWidth(name)) * 0.5, tabTop + (this.tabHeight - labelHeight) * 0.5 + 2.0, name,
                gray, gray, gray, 1.0, 0);
        }
        for (let i = 0; i < this.groupTiles.length; i++) {
            const tile = this.groupTiles[i];
            const x0 = i * tileWidth - this.toolbarScroll;
            if (x0 + tileWidth <= 0.0 || x0 >= this.width) {
                continue;
            }
            const selected = tile.tool == this.tool || (tile.tool == ACTION_PAUSE && this.paused)
                || (tile.tool == ACTION_GRAVITY && this.tool == GRAVITY_PLACE);
            if (selected) {
                Nri_ImguiDrawRect(x0 + 1.0, top + 1.0, x0 + tileWidth - 1.0, bottom - 1.0, 0.95, 0.95, 0.95, 1.0);
            }
            Nri_ImguiDrawRect(x0 + pad, top + pad, x0 + tileWidth - pad, bottom - pad - labelHeight, tile.r, tile.g, tile.b, 1.0);
            let label = tile.label;
            if (tile.tool == ACTION_PAUSE && this.paused) {
                label = "Play";
            } else if (tile.tool == ACTION_SHAPE) {
                label = SHAPE_NAMES[this.brushShape];
            } else if (tile.tool == ACTION_GRAVITY) {
                label = GRAVITY_LABELS[this.gravityMode];
            } else if (tile.tool == EMITTER) {
                // What it emits, in the middle of its swatch.
                let emitted = tile;
                for (const other of this.tiles) {
                    if (other.tool == this.emitType) {
                        emitted = other;
                    }
                }
                const cx = x0 + tileWidth * 0.5;
                const cy = (top + bottom - labelHeight) * 0.5;
                const half = tileWidth * 0.15;
                Nri_ImguiDrawRect(cx - half, cy - half, cx + half, cy + half, emitted.r, emitted.g, emitted.b, 1.0);
            }
            const textWidth = Nri_ImguiCalcTextWidth(label);
            Nri_ImguiDrawText(x0 + (tileWidth - textWidth) * 0.5, bottom - pad - labelHeight + 2.0, label,
                selected ? 0.0 : 1.0, selected ? 0.0 : 1.0, selected ? 0.0 : 1.0, 1.0, 0);
        }
        // When a row scrolls, a bar along its top: how much of it shows, and where.
        if (this.maxTabScroll() > 0.0) {
            Nri_ImguiDrawRect(this.tabScroll / this.tabEnd * this.width, tabTop, (this.tabScroll + this.width) / this.tabEnd * this.width,
                tabTop + 3.0, 0.7, 0.7, 0.75, 1.0);
        }
        if (this.maxScroll() > 0.0) {
            const total = this.groupTiles.length * tileWidth;
            const barX0 = this.toolbarScroll / total * this.width;
            const barX1 = (this.toolbarScroll + this.width) / total * this.width;
            Nri_ImguiDrawRect(barX0, top, barX1, top + 3.0, 0.7, 0.7, 0.75, 1.0);
        }

        // The size slider: "Size N", then its track and knob.
        let hudTop = 6.0;
        if (this.sliderShown()) {
            const sliderTop = this.sliderTop();
            const sliderHeight = this.sliderHeight();
            const sizeLabel = `Size ${formatFixed(this.brushRadius, this.brushRadius < 1.0 ? 1 : 0)}`;
            this.sliderX0 = 8.0 + Nri_ImguiCalcTextWidth("Size 30.0") + sliderHeight;
            this.sliderX1 = Math.min(this.width - 8.0 - sliderHeight * 0.5, this.sliderX0 + this.width * 0.6);
            Nri_ImguiDrawRect(0.0, sliderTop - 2.0, this.sliderX1 + sliderHeight, sliderTop + sliderHeight + 2.0, 0.08, 0.08, 0.1, 0.8);
            Nri_ImguiDrawText(8.0, sliderTop + (sliderHeight - labelHeight) * 0.5 + 2.0, sizeLabel, 1.0, 1.0, 1.0, 1.0, 0);
            const mid = sliderTop + sliderHeight * 0.5;
            Nri_ImguiDrawRect(this.sliderX0, mid - 2.0, this.sliderX1, mid + 2.0, 0.45, 0.45, 0.5, 1.0);
            const t = (this.brushRadius - MIN_BRUSH) / (MAX_BRUSH - MIN_BRUSH);
            const knobX = this.sliderX0 + t * (this.sliderX1 - this.sliderX0);
            const knob = sliderHeight * 0.3;
            Nri_ImguiDrawRect(this.sliderX0, mid - 2.0, knobX, mid + 2.0, 0.95, 0.95, 0.95, 1.0);
            Nri_ImguiDrawRect(knobX - knob, mid - knob * 1.4, knobX + knob, mid + knob * 1.4, 0.95, 0.95, 0.95, 1.0);
            hudTop = sliderTop + sliderHeight + 6.0;
        }
        // The brushes' menu: an icon for each shape, the brush's lit.
        if (this.menuOpen) {
            const half = this.menuIconHalf();
            for (let k = 0; k < SHAPE_NAMES.length; k++) {
                const cx = this.menuIconX(k);
                const cy = this.menuIconY(k);
                const lit = k == this.brushShape;
                Nri_ImguiDrawRect(cx - half, cy - half, cx + half, cy + half, lit ? 0.95 : 0.12, lit ? 0.95 : 0.12, lit ? 0.95 : 0.15, 0.92);
                this.drawShapeIcon(k, cx, cy - labelHeight * 0.35, half * 0.5, lit ? 0.1 : 0.9);
                const name = SHAPE_NAMES[k];
                const shade = lit ? 0.0 : 1.0;
                Nri_ImguiDrawText(cx - Nri_ImguiCalcTextWidth(name) * 0.5, cy + half - labelHeight, name, shade, shade, shade, 1.0, 0);
            }
        }

        // Particles in use, the brush, the view; the cell under the pointer.
        const used = CAPACITY - this.probe[0];
        let y = this.drawWrapped([`${formatFixed(this.frameRate, 0)} fps`, `step ${formatFixed(this.stepMs, 2)} ms`,
            `particles ${used} / ${CAPACITY}`,
            `brush ${formatFixed(this.brushRadius, 0)} ${SHAPE_NAMES[this.brushShape]}`, `view: ${VIEW_NAMES[this.overlay]}`,
            this.zoom > 1.001 ? `zoom ${formatFixed(this.zoom, 1)}x` : "",
            this.paused ? "PAUSED" : ""], hudTop, labelHeight, 1.0);
        const cell = this.probe[3] & 0xFF;
        let contents = materialName(cell);
        if (cell < WALL) {
            contents = "";
            for (let k = 0; k < PARTICLE_TYPES; k++) {
                const n = (this.probe[4 + Math.floor(k / 4)] >> (8 * (k % 4))) & 0xFF;
                if (n > 0) {
                    contents = `${contents}${contents == "" ? "" : ", "}${n} ${materialName(sectionMaterial(k))}`;
                }
            }
            if (contents == "") {
                contents = "air";
            }
            // (probe_cs puts the water's salinity last)
            if ((this.probe[4] & 0xFF) > 0 && this.probeFloats[PROBE_INTS - 1] > 0.01) {
                contents = `${contents} (salinity ${formatFixed(100.0 * this.probeFloats[PROBE_INTS - 1], 0)}%)`;
            }
        }
        const windX = this.probeFloats[PROBE_AIR];
        const windY = this.probeFloats[PROBE_AIR + 1];
        const wind = Math.sqrt(windX * windX + windY * windY);
        y = this.drawWrapped([`${formatFixed(this.probeFloats[1], 1)} C`, `pressure ${formatFixed(this.probeFloats[2], 2)}`, contents,
            wind >= 0.5 ? `wind ${formatFixed(wind, 0)}` : ""], y, labelHeight, 0.85);
        const level = this.level;
        if (level && level.goalCount > 0) {
            const count = this.probe[PROBE_GOAL];
            const progress = level.goalAtMost ? `${count} (at most ${level.goalCount}${level.goalHold > 0.0 ? ` for ${formatFixed(level.goalHold, 0)} s` : ""})`
                : `${Math.min(count, level.goalCount)} / ${level.goalCount}`;
            const time = this.goalReached ? this.goalTime : Math.max(this.levelTime, 0.0);
            let stars = "";
            if (this.goalReached) {
                stars = this.goalStars > 0 ? `done ${starText(this.goalStars)}` : "done";
            } else if (level.stars.length >= 2) {
                stars = `*** in ${formatFixed(level.stars[0], 0)} s, ** in ${formatFixed(level.stars[1], 0)} s`;
            }
            y = this.drawWrapped([`${level.name}: ${level.goalText} ${progress}`, `${formatFixed(time, 1)} s`, stars], y, labelHeight, 1.0);
        }
        if (this.messageTime > 0.0) {
            Nri_ImguiDrawText(8.0, y, this.message, 1.0, 0.9, 0.4, 1.0, 0);
        }
        Nri_ImguiRender(this.sample);
    }

    // A shape's glyph (SHAPE_NAMES' k) at (cx, cy), r in size, in gray: a disc, a square, a
    // diagonal line, a box's outline (rectangles: ImGui's draw list here has only those).
    drawShapeIcon(k: int, cx: number, cy: number, r: number, gray: number) {
        if (k == SHAPE_CIRCLE) {
            const rows = Math.max(Math.floor(r), 4);
            for (let i = -rows; i < rows; i++) {
                const y = (i + 0.5) / rows;
                const w = r * Math.sqrt(Math.max(1.0 - y * y, 0.0));
                Nri_ImguiDrawRect(cx - w, cy + i * r / rows, cx + w, cy + (i + 1) * r / rows, gray, gray, gray, 1.0);
            }
        } else if (k == SHAPE_SQUARE) {
            Nri_ImguiDrawRect(cx - r * 0.85, cy - r * 0.85, cx + r * 0.85, cy + r * 0.85, gray, gray, gray, 1.0);
        } else if (k == SHAPE_LINE) {
            const steps = Math.max(Math.floor(r), 6);
            const t = Math.max(r * 0.12, 2.0);
            for (let i = 0; i <= steps; i++) {
                const f = -1.0 + 2.0 * i / steps;
                Nri_ImguiDrawRect(cx + f * r - t, cy - f * r - t, cx + f * r + t, cy - f * r + t, gray, gray, gray, 1.0);
            }
        } else {
            const t = Math.max(r * 0.14, 2.0);
            Nri_ImguiDrawRect(cx - r, cy - r, cx + r, cy - r + t, gray, gray, gray, 1.0);
            Nri_ImguiDrawRect(cx - r, cy + r - t, cx + r, cy + r, gray, gray, gray, 1.0);
            Nri_ImguiDrawRect(cx - r, cy - r, cx - r + t, cy + r, gray, gray, gray, 1.0);
            Nri_ImguiDrawRect(cx + r - t, cy - r, cx + r, cy + r, gray, gray, gray, 1.0);
        }
    }

    // The HUD's parts (empty ones left out) on a line from y, three spaces apart, wrapped onto
    // more lines where the window is too narrow (a phone held upright); the y under them.
    drawWrapped(parts: string[], y: number, lineHeight: number, gray: number): number {
        const gap = Nri_ImguiCalcTextWidth("   ");
        let x = 8.0;
        for (const part of parts) {
            if (part == "") {
                continue;
            }
            const width = Nri_ImguiCalcTextWidth(part);
            if (x > 8.0 && x + width > this.width - 8.0) {
                x = 8.0;
                y += lineHeight;
            }
            Nri_ImguiDrawText(x, y, part, gray, gray, gray, 1.0, 0);
            x += width + gap;
        }
        return y + lineHeight;
    }

    recordDraw(commandBuffer: NriCommandBufferHandle) {
        const drawLayout = this.drawLayout;
        const drawPipeline = this.drawPipeline;
        if (!drawLayout || !drawPipeline) {
            return;
        }
        Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
        Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
        Nri_CmdSetPipelineLayout(commandBuffer, drawLayout);
        Nri_CmdSetPipeline(commandBuffer, drawPipeline);
        Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.constants[0]), CONSTANTS_SIZE);
        Nri_CmdSetDescriptorPool(commandBuffer, this.descriptorPool);
        Nri_CmdSetDescriptorSet(commandBuffer, 0, this.drawSet);
        Nri_CmdDraw(commandBuffer, 3, 1, 0, 0);
    }

    renderFrame(frameIndex: int) {
        this.resizeIfNeeded();
        this.frameIndex = frameIndex;
        const queuedFrame = this.queuedFrames[frameIndex % this.queuedFrames.length];
        const frameTime = this.test ? 1.0 / 60.0 : Math.min(Nri_GetFrameTime(this.sample), 0.25);
        this.time += frameTime;
        this.messageTime -= frameTime;
        this.fpsFrames++;
        this.fpsTime += Nri_GetFrameTime(this.sample);
        if (this.fpsTime >= 0.5) {
            this.frameRate = this.fpsFrames / this.fpsTime;
            this.fpsFrames = 0;
            this.fpsTime = 0.0;
        }

        // The readout this slot's last frame wrote, and its simulation's time.
        if (frameIndex >= this.queuedFrames.length) {
            Nri_ReadBufferInts(queuedFrame.probeReadback, Ref(this.probe[0]), PROBE_INTS + EVENT_COUNT);
            Nri_ReadBufferFloats(queuedFrame.probeReadback, Ref(this.probeFloats[0]), PROBE_INTS);
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
        const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
        const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
        if (index >= 0) {
            const swapChainTexture = this.swapChainTextures[index];
            const commandBuffer = queuedFrame.commandBuffer;

            // Record: the simulation's steps, the readout, then the grid drawn and the toolbar
            // over it.
            Nri_BeginCommandBuffer(commandBuffer);
            this.recordStateRequests(commandBuffer);
            const queryPool = this.queryPool;
            const queryBase = (frameIndex % this.queuedFrames.length) * 2;
            if (queryPool) {
                Nri_CmdResetQueries(commandBuffer, queryPool, queryBase, 2);
                Nri_CmdWriteTimestamp(commandBuffer, queryPool, queryBase);
            }
            this.beginProfile(commandBuffer);
            this.recordSimulation(commandBuffer, brushMode, steps);
            this.recordSparks(commandBuffer, brushMode);
            this.recordGlow(commandBuffer);
            this.endProfile(commandBuffer);
            queuedFrame.steps = this.paused ? 0 : steps;
            queuedFrame.levelTime = this.levelTime;
            const timestampReadback = queuedFrame.timestampReadback;
            if (queryPool) {
                Nri_CmdWriteTimestamp(commandBuffer, queryPool, queryBase + 1);
                if (timestampReadback) {
                    Nri_CmdCopyQueries(commandBuffer, queryPool, queryBase, 2, timestampReadback, 0);
                    queuedFrame.timedSteps = this.paused ? 0 : steps;
                }
            }
            this.dispatch(commandBuffer, PROBE, 1, 0);
            // (the brush's fields stand for the goal's material and box)
            const level = this.level;
            if (level && level.goalCount > 0) {
                this.setInt(8, level.goalMaterial | (level.goalLit ? GOAL_LIT : 0));
                this.setFloat(10, level.goalBox[0] * this.gridW);
                this.setFloat(11, level.goalBox[1] * this.gridH);
                this.setFloat(12, level.goalBox[2] * this.gridW);
                this.setFloat(13, level.goalBox[3] * this.gridH);
                this.dispatch(commandBuffer, GOAL, 1, 0);
                this.setInt(8, this.tool);
            }
            const alloc = this.buffers[4];
            Nri_CmdBufferBarrier(commandBuffer, alloc, NriBufferState.Storage, NriBufferState.CopySource);
            Nri_CmdCopyBuffer(commandBuffer, queuedFrame.probeReadback, alloc, PROBE_INTS * 4);
            Nri_CmdBufferBarrier(commandBuffer, alloc, NriBufferState.CopySource, NriBufferState.Storage);
            // (then the last step's events)
            const gridInt = this.buffers[1];
            Nri_CmdBufferBarrier(commandBuffer, gridInt, NriBufferState.Storage, NriBufferState.CopySource);
            Nri_CmdCopyBufferRegion(commandBuffer, queuedFrame.probeReadback, PROBE_INTS * 4, gridInt, I_EVENTS * this.stride * 4,
                EVENT_COUNT * 4);
            Nri_CmdBufferBarrier(commandBuffer, gridInt, NriBufferState.CopySource, NriBufferState.Storage);
            const testReadback = this.testReadback;
            if (testReadback) {
                if (frameIndex == this.testFrames - 1) {
                    Nri_CmdBufferBarrier(commandBuffer, this.buffers[1], NriBufferState.Storage, NriBufferState.CopySource);
                    Nri_CmdCopyBuffer(commandBuffer, testReadback, this.buffers[1], ALL_INT_SECTIONS * this.stride * 4);
                    Nri_CmdBufferBarrier(commandBuffer, this.buffers[1], NriBufferState.CopySource, NriBufferState.Storage);
                    const cellsReadback = this.cellsReadback;
                    if (cellsReadback) {
                        Nri_CmdBufferBarrier(commandBuffer, this.buffers[3], NriBufferState.Storage, NriBufferState.CopySource);
                        Nri_CmdCopyBuffer(commandBuffer, cellsReadback, this.buffers[3], this.stride * 4);
                        Nri_CmdBufferBarrier(commandBuffer, this.buffers[3], NriBufferState.CopySource, NriBufferState.Storage);
                    }
                    const floatReadback = this.floatReadback;
                    if (floatReadback) {
                        Nri_CmdBufferBarrier(commandBuffer, this.buffers[2], NriBufferState.Storage, NriBufferState.CopySource);
                        Nri_CmdCopyBuffer(commandBuffer, floatReadback, this.buffers[2], FLOAT_SECTIONS * this.stride * 4);
                        Nri_CmdBufferBarrier(commandBuffer, this.buffers[2], NriBufferState.CopySource, NriBufferState.Storage);
                    }
                }
            }
            const shown = B_GRID_INT | B_GRID_FLOAT | B_CELLS;
            this.barriers(commandBuffer, shown, NriBufferState.Storage, NriBufferState.PixelShaderResource);
            if (this.imgui) {
                Nri_CmdCopyImguiData(this.sample, commandBuffer);
            }
            Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
            Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
            Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 1.0);
            this.recordDraw(commandBuffer);
            if (this.imgui) {
                Nri_CmdDrawImguiUnconverted(this.sample, commandBuffer, this.viewFormat);
            }
            Nri_CmdEndRendering(commandBuffer);
            this.barriers(commandBuffer, shown, NriBufferState.PixelShaderResource, NriBufferState.Storage);
            let presentFrom = NriTextureState.ColorAttachment;
            const frameReadback = this.frameReadback;
            if (frameReadback) {
                if (frameIndex == this.testFrames - 1) {
                    Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.ColorAttachment, NriTextureState.CopySource);
                    Nri_CmdReadbackTextureToBuffer(commandBuffer, frameReadback, this.rowPitch, swapChainTexture.texture, this.width, this.height);
                    presentFrom = NriTextureState.CopySource;
                }
            }
            Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, presentFrom, NriTextureState.Present);
            Nri_EndCommandBuffer(commandBuffer);

            // Submit and present
            Nri_QueueSubmit(this.queue, commandBuffer, acquireSemaphore, swapChainTexture.releaseSemaphore);
            if (this.imgui) {
                Nri_ImguiEndFrame(this.sample);
            }
            Nri_QueuePresent(this.swapChain, swapChainTexture.releaseSemaphore);
        }

        // Signaled after the present, as NRISamples do
        Nri_QueueSignal(this.queue, this.frameFence, 1 + frameIndex);
        this.finishStateRequests();
    }

    // Sounds for the events the probe's readout carries (its frame's last step's, of steps): each
    // when there are enough, louder the more, then not again for its cooldown.
    playSounds(steps: int, frameTime: number) {
        if (steps <= 0) {
            return;
        }
        for (let k = 0; k < EVENT_COUNT; k++) {
            const events = this.probe[PROBE_INTS + k] * steps;
            this.eventTotals[k] += events;
            this.soundCooldowns[k] -= frameTime;
            // (nested: tslang's && can't take a @cpp handle, issue #23)
            const audio = this.audio;
            if (audio) {
                if (!this.test && events >= EVENT_MIN[k] && this.soundCooldowns[k] <= 0.0) {
                    const loudness = Math.min(0.25 + 0.75 * Math.log(1.0 + events) / Math.log(1.0 + EVENTS_LOUD[k]), 1.0);
                    // (bigger booms lower)
                    const pitch = k == 3 ? 1.2 - 0.5 * Math.min(events / EVENTS_LOUD[k], 1.0) : 0.85 + 0.3 * Math.random();
                    Nri_PlaySound(audio, k, loudness, pitch);
                    this.soundCooldowns[k] = EVENT_COOLDOWN[k] * (0.8 + 0.4 * Math.random());
                }
            }
        }
    }

    // The simulation's GPU time per step, from the frame this slot last recorded (finished: latencySleep
    // waited for it), if it stepped.
    readTimestamps(queuedFrame: QueuedFrame) {
        const device = this.device;
        const timestampReadback = queuedFrame.timestampReadback;
        if (!device || !timestampReadback) {
            return;
        }
        const steps = queuedFrame.timedSteps;
        queuedFrame.timedSteps = -1;
        if (steps > 0) {
            const ms = Nri_ReadTimestampIntervalMs(device, timestampReadback, 0, this.querySize);
            if (ms >= 0.0) {
                this.stepMs = ms / steps;
            }
        }
    }

    // -test's checks (checks.ts's PowderSandbox has them): "" if they pass, else what failed.
    checkTest(): string {
        return "the test's checks aren't in this build";
    }

    destroy() {
        const audio = this.audio;
        if (audio) {
            Nri_DestroyAudio(audio);
            this.audio = null;
        }
        const device = this.device;
        if (device) {
            Nri_DeviceWaitIdle(device);
            if (this.imgui) {
                Nri_DestroyImgui(this.sample);
            }
            for (const queuedFrame of this.queuedFrames) {
                Nri_DestroyCommandBuffer(queuedFrame.commandBuffer);
                Nri_DestroyCommandAllocator(queuedFrame.commandAllocator);
                Nri_DestroyBuffer(queuedFrame.probeReadback);
                const timestampReadback = queuedFrame.timestampReadback;
                if (timestampReadback) {
                    Nri_DestroyBuffer(timestampReadback);
                }
            }
            const queryPool = this.queryPool;
            if (queryPool) {
                Nri_DestroyQueryPool(queryPool);
            }
            const profilePool = this.profilePool;
            if (profilePool) {
                Nri_DestroyQueryPool(profilePool);
            }
            const profileReadback = this.profileReadback;
            if (profileReadback) {
                Nri_DestroyBuffer(profileReadback);
            }
            this.destroySwapChain();
            for (const view of this.storageViews) {
                Nri_DestroyDescriptor(view);
            }
            Nri_DestroyDescriptorPool(this.descriptorPool);
            for (const view of this.shaderViews) {
                Nri_DestroyDescriptor(view);
            }
            for (const buffer of this.buffers) {
                Nri_DestroyBuffer(buffer);
            }
            const testReadback = this.testReadback;
            if (testReadback) {
                Nri_DestroyBuffer(testReadback);
            }
            const cellsReadback = this.cellsReadback;
            if (cellsReadback) {
                Nri_DestroyBuffer(cellsReadback);
            }
            const floatReadback = this.floatReadback;
            if (floatReadback) {
                Nri_DestroyBuffer(floatReadback);
            }
            const frameReadback = this.frameReadback;
            if (frameReadback) {
                Nri_DestroyBuffer(frameReadback);
            }
            for (const pipeline of this.pipelines) {
                Nri_DestroyPipeline(pipeline);
            }
            const drawPipeline = this.drawPipeline;
            if (drawPipeline) {
                Nri_DestroyPipeline(drawPipeline);
            }
            const computeLayout = this.computeLayout;
            if (computeLayout) {
                Nri_DestroyPipelineLayout(computeLayout);
            }
            const drawLayout = this.drawLayout;
            if (drawLayout) {
                Nri_DestroyPipelineLayout(drawLayout);
            }
            for (const undoBuffer of this.undoBuffers) {
                Nri_DestroyBuffer(undoBuffer);
            }
            Nri_DestroyFence(this.frameFence);
            Nri_DestroyDevice(device);
        }
        Nri_DestroySample(this.sample);
    }
}

/// <reference path="../../../core/nri/nri_interop.d.ts" />
import { formatFixed } from "../../../core/text_format";
import { JsonReader } from "../../../core/json_reader";
import {
    WINDOW_TITLE, TEST_FRAMES, CAPACITY, DEFAULT_GRID_HEIGHT, QUALITY_FRAMES, STEP_BUDGET_MS,
    MIN_GRID_HEIGHT, QUALITY_PATH, QUALITY_MAGIC, QUALITY_HEADER_INTS, MAX_GRID_LONG, GRID_CAPACITY,
    MIN_TILE_WIDTH, DRAG_THRESHOLD, ZOOM_STEP, MAX_ZOOM, STROKE_CANCEL_TIME, LONG_PRESS_TIME,
    PROFILE_EVERY, PROFILE_QUERIES, PROFILE_REPORT, MIN_BRUSH, MAX_BRUSH, MOUSE_MIDDLE, GROUP_SIZE,
    CONSTANTS_FLOATS, CONSTANTS_SIZE, PARTICLE_TYPES, SPARK_ITERATIONS, ALL_INT_SECTIONS,
    INT_SECTIONS, I_EVENTS, EVENT_COUNT, EVENT_MIN, EVENT_COOLDOWN, EVENTS_LOUD, FLOAT_SECTIONS,
    F_BODY, MAX_BODIES, BODY_FLOATS, ALLOC_LIST, F_TPRE, CARRIED_FLOAT_SECTIONS, PARTICLE_SIZE,
    PROBE_INTS, PROBE_VISCOUS, PROBE_AIR, PROBE_GOAL, GRAVITY, FLIP_RATIO, SOR_OMEGA,
    DEFAULT_SUBSTEPS, DEFAULT_ITERATIONS, SOLVER_SOR, SOLVER_MULTIGRID, DEFAULT_VCYCLES,
    DEFAULT_SMOOTH, DEFAULT_VISCOSITY_SWEEPS, WATER, OIL, SAND, FIRE, LAVA, ACID, SALT, GUNPOWDER,
    HONEY, PETROL, WALL, GLASS, WOOD, URANIUM, EMITTER, ICE, STONE, METAL, FAN, BLOCK, BATTERY,
    LAMP, ERASE, HEAT, COOL, SALT_WATER, SPARK, C4, COAL, FUSE, HYDROGEN, OXYGEN, NEON, THERMITE,
    NITRO, SEED, CLONE, BLACK_HOLE, WHITE_HOLE, SPONGE, SWITCH, DETECTOR, HEATER, INSPECT,
    INIT_GRID, INIT_PARTICLES, CLEAR, P2G, GRID, HEAT_SOURCE, HEAT_DIFFUSE, DIVERGENCE, PRESSURE,
    PROJECT, G2P, SPAWN, PROBE, REGRID_GRID, REGRID_PARTICLES, MG_SETUP, MG_SMOOTH, MG_RESTRICT,
    MG_PROLONG, MG_COARSE, VISCOSITY, AIR, BODIES, GOAL, GLOW_EMIT, GLOW_X, GLOW_Y, SPARKS,
    AIR_FLOATS, ENTRIES, B_GRID_INT, B_GRID_FLOAT, B_CELLS, B_MG, B_ALL, BUFFERS, Tile,
    ACTION_SMALLER, ACTION_LARGER, ACTION_PAUSE, ACTION_VIEW, ACTION_CLEAR, ACTION_SHAPE,
    ACTION_UNDO, ACTION_SAVE, ACTION_LOAD, ACTION_LEVEL, ACTION_GRAVITY, GRAVITY_DOWN,
    GRAVITY_POINT, GRAVITY_TILT, GRAVITY_NAMES, GRAVITY_LABELS, TILT_FLAT, STANDARD_GRAVITY,
    GRAVITY_PLACE, LEVEL_DIRECTORY, BLOW_NAMES, GOAL_LIT, STARS_PATH, STARS_MAGIC, STATE_BUFFERS,
    UNDO_DEPTH, SAVE_PATH, SAVE_MAGIC, SAVE_VERSION, SAVE_HEADER_INTS, SAVE_HEADER_INTS_3,
    MESSAGE_TIME, KEY_Z, KEY_LEFT_CONTROL, KEY_RIGHT_CONTROL, VIEW_NAMES, ICE_BLOCK, BARS,
    HEAT_STROKES, ACID_TUB, SALT_TANK, SALT_POUR, GUNPOWDER_PILE, SAND_LAYER, GUNPOWDER_WALL, POOL,
    DAM, HONEY_DIVIDER, BEAD, WIND_FAN, WIND_SAND, BODY_POOL, FLOATER, LEDGE, TIPPER, TUBS, TUB_TOP,
    TUB_LIQUID, ACID_POUR, FIRE_BAND, GAS_WOOD, GAS_CEILING, GAS_PROBE, BLOBS, CIRCUITS, WIRE,
    SPARK_WIRE, SPARK_POWDER, CONTROL_POWDER, ELECTRO_TUBS, ELECTRO_Y, ELECTRO_WIRE, NEON_TUBES,
    H2_BOXES, H2_Y, FUSES, BURN_BLOCKS, BURN_TOP, PLATES, PLATE_Y, THERMITE_TOP, NITRO_TUBS,
    NITRO_TOP, NITRO_DROP, C4_BLOCKS, C4_Y, CLONED, CLONE_DROP, CLONE_TWIN, CLONE_TUBS,
    CLONE_TUB_TOP, HOLE_XS, HOLE_Y, HOLE_W, HOLE_SAND, SPONGE_BOX, SPONGE_TWIN, SPONGE_TUBS,
    SPONGE_TUB_TOP, SPONGE_WATER, SEED_POOL, SEED_WET, SEED_LEDGE, SWITCH_ROWS, SWITCH_X, LAMP_X,
    DETECTOR_ROWS, HEATERS, SHAPE_CIRCLE, SHAPE_SQUARE, SHAPE_LINE, SHAPE_BOX, SHAPE_NAMES,
    levelSize, levelCount, multigridFloats, fanDirectionOf, sectionMaterial, materialName,
    toolNamed, LevelStroke, Level, starText, Stroke, QueuedFrame, SwapChainTexture
} from "./defs";

// The callbacks given to C++, kept for as long as it may call them.
let retainedInitializeCallbacks: NriInitializeCallback[] = [];
let retainedFrameCallbacks: NriFrameCallback[] = [];

// The sandbox: its GPU resources, simulation, toolbar and input, scenes and levels, run with NRI.
export class SandboxApp {
    protected device: NriDeviceHandle | null = null;
    protected queue: NriQueueHandle;
    protected frameFence: NriFenceHandle;
    protected swapChain: NriSwapChainHandle;
    protected viewFormat: NriFormat = NriFormat.Unknown;
    protected swapChainTextures: SwapChainTexture[] = [];
    protected queuedFrames: QueuedFrame[] = [];
    protected computeLayout: NriPipelineLayoutHandle | null = null;
    protected drawLayout: NriPipelineLayoutHandle | null = null;
    protected pipelines: NriPipelineHandle[] = [];
    protected drawPipeline: NriPipelineHandle | null = null;
    protected imgui: boolean = false;

    // u0 .. u4 of the compute entries, t0 .. t2 of the display.
    protected buffers: NriBufferHandle[] = [];
    protected storageViews: NriDescriptorHandle[] = [];
    protected shaderViews: NriDescriptorHandle[] = [];
    // Their descriptor sets (plain sets, not root descriptors: Vulkan's need push descriptors,
    // which many Android devices lack).
    protected descriptorPool: NriDescriptorPoolHandle;
    protected computeSet: NriDescriptorSetHandle;
    protected drawSet: NriDescriptorSetHandle;
    protected testReadback: NriBufferHandle | null = null;
    protected cellsReadback: NriBufferHandle | null = null;
    // -test: the last frame, read back.
    protected frameReadback: NriBufferHandle | null = null;
    // The byte sizes of this.buffers, and of the state (STATE_BUFFERS' together).
    protected bufferSizes: int[] = [];
    protected stateSize: int = 0;
    // Undo: UNDO_DEPTH snapshot buffers (in CopyDestination between uses), the newest's index and
    // how many hold a state.
    protected undoBuffers: NriBufferHandle[] = [];
    protected undoTop: int = 0;
    protected undoCount: int = 0;
    // The grid's size each snapshot was taken at.
    protected undoW: int[] = [];
    protected undoH: int[] = [];
    // What the next frame does to the state before simulating: take a snapshot, restore the
    // newest, save it, load the save.
    protected snapshotRequested: boolean = false;
    protected undoRequested: boolean = false;
    protected saveRequested: boolean = false;
    protected loadRequested: boolean = false;
    // This frame's save (read back, written once the frame is done) or load (uploaded from the
    // file).
    protected saveReadback: NriBufferHandle | null = null;
    protected loadBuffer: NriBufferHandle | null = null;
    // The loaded save's grid size, and whether it's still to be copied in.
    protected loadW: int = 0;
    protected loadH: int = 0;
    protected loadPending: boolean = false;
    protected message: string = "";
    protected messageTime: number = 0.0;
    // -roundTrip (a test): halfway through, the state is cleared and undone, then saved, cleared
    // and loaded; the U-tube must still level out.
    roundTrip: boolean = false;
    // -regrid N (a test): halfway through, the grid remade 1 taller, and back 100 frames later
    // (nothing may be lost); 2 turned (its width and height swapped), cropping it.
    regrid: int = 0;
    protected regridCount: int = 0;
    // Whether a Clear repaints the scene's strokes (the round trip's doesn't).
    protected sceneOnClear: boolean = true;
    protected rowPitch: int = 0;

    protected width: int = 0;
    protected height: int = 0;
    protected gridW: int = 0;
    protected gridH: int = DEFAULT_GRID_HEIGHT;
    protected stride: int = 0;
    // The size of the grid the buffers hold, as this frame's recording goes: when it's not
    // gridW x gridH, recordStateRequests remakes it (the window turned).
    protected stateW: int = 0;
    protected stateH: int = 0;
    protected toolbarHeight: number = 0.0;
    protected tileWidth: number = MIN_TILE_WIDTH;
    protected tileHeight: number = 56.0;
    // The tiles' row scrolled left by this many pixels (0 .. maxScroll()); the tabs' row, its
    // height, and its tabs' left edges and right end (as buildUI last laid them out).
    protected toolbarScroll: number = 0.0;
    protected tabScroll: number = 0.0;
    protected tabHeight: number = 32.0;
    protected tabX: number[] = [];
    protected tabEnd: number = 0.0;
    protected viewX: number = 0.0;
    protected viewY: number = 0.0;
    protected cellPixels: number = 1.0;
    // The view: zoom (1 shows the whole grid) and the grid point (in cells) in the middle of the
    // area above the toolbar. -zoom Z starts zoomed (a test's view).
    zoom: number = 1.0;
    startZoom: number = 1.0;
    protected centerX: number = 0.0;
    protected centerY: number = 0.0;
    // The middle button (or two fingers) down last frame, and where the pointer was then.
    protected middleWasDown: boolean = false;
    protected panX: number = 0.0;
    protected panY: number = 0.0;
    // When the stroke in progress began (this.time), to take it back if it turns into a pinch.
    protected pressTime: number = 0.0;

    protected tiles: Tile[] = [];
    // The groups' names; the group shown, and its tiles.
    protected groups: string[] = [];
    protected group: int = 0;
    protected groupTiles: Tile[] = [];
    protected tool: int = WATER;
    protected emitType: int = WATER;
    protected brushRadius: number = 3.0;
    protected brushShape: int = SHAPE_CIRCLE;
    protected paused: boolean = false;
    // -view N: 0 materials, 1 pressure, 2 temperature.
    overlay: int = 0;
    protected needsInit: boolean = true;
    protected time: number = 0.0;
    protected frameRate: number = 0.0;
    // The GPU's time for the simulation (a queued frame's two timestamps), the last frame's that
    // stepped, per step.
    protected queryPool: NriQueryPoolHandle | null = null;
    // -profile: its queries and their readback, the entries the frame being timed dispatched (one
    // a timestamp after the first), whether one's being recorded, the frame whose are waiting to be
    // read (-1 none), the milliseconds summed for each entry over the frames read.
    profile: boolean = false;
    protected profilePool: NriQueryPoolHandle | null = null;
    protected profileReadback: NriBufferHandle | null = null;
    protected profileEntries: int[] = [];
    protected profiling: boolean = false;
    protected profileFrame: int = -1;
    protected profileSums: number[] = [];
    protected profileFrames: int = 0;
    protected querySize: int = 8;
    protected stepMs: number = 0.0;
    protected fpsFrames: int = 0;
    protected fpsTime: number = 0.0;

    // The pointer: down last frame, where (in cells), whether the press began on the toolbar; a
    // press there: where it began, the scroll then, whether it has dragged the row yet.
    protected wasDown: boolean = false;
    protected zWasDown: boolean = false;
    protected pressOnToolbar: boolean = false;
    protected pressX: number = 0.0;
    protected pressY: number = 0.0;
    // The press went to the menu or the size slider, not the grid; it opened the menu (held);
    // the menu's open, around (menuX, menuY).
    protected pressOnUi: boolean = false;
    protected pressOnSlider: boolean = false;
    protected longPressed: boolean = false;
    protected menuOpen: boolean = false;
    protected menuX: number = 0.0;
    protected menuY: number = 0.0;
    // The size slider's track, from sliderX0 to sliderX1 (as buildUI last laid it out), and its
    // row's top and height.
    protected sliderX0: number = 0.0;
    protected sliderX1: number = 0.0;
    protected pressScroll: number = 0.0;
    protected dragging: boolean = false;
    protected lastGridX: number = 0.0;
    protected lastGridY: number = 0.0;
    protected mouseGridX: number = 0.0;
    protected mouseGridY: number = 0.0;
    // Where a press on the grid began (in cells): a line's or a box's first corner.
    protected anchorX: number = 0.0;
    protected anchorY: number = 0.0;
    // The way a fan being painted blows (0 right, 1 down, 2 left, 3 up): the way the pointer
    // went from where it was pressed, up for a tap.
    protected fanDirection: int = 3;

    protected constants: f32[] = [];
    protected probe: int[] = [];
    protected probeFloats: f32[] = [];

    // Options: -scene N (1, or -utube: the test's U-tube; 2 a showcase of the materials; 3 lava,
    // ice and stone; 4 metal, acid and salt; 5 gunpowder; 6 honey and water; 7 a film of water
    // beading; 8 a fan blowing falling sand; 9 blocks floating and tipping over; -air 0: still air;
    // -bodies 0: no rigid bodies);
    // -substeps N; -solver sor|multigrid, -iterations N (SOR's sweeps), -vcycles N, -smooth N;
    // -viscosity N (viscosity_cs's sweep pairs, 0 none).
    scene: int = 0;
    // -sceneFile name: a level from LEVEL_DIRECTORY instead (its goal must be reached in a test);
    // -solve S: its solution painted S seconds in (the goal mustn't be reached before); -testStars
    // N: the stars it must earn (0: the goal mustn't be reached).
    sceneFile: string = "";
    solveTime: number = -1.0;
    testStars: int = -1;
    protected level: Level | null = null;
    protected levelNames: string[] = [];
    protected levelIndex: int = -1;
    protected bestStars: int[] = [];
    protected goalReached: boolean = false;
    // The level's time (simulated seconds since its strokes were painted; -1 till then), since
    // when its goal has been met (-1: it isn't), when it was reached and its stars, whether the
    // solution was painted (-solve).
    protected levelTime: number = -1.0;
    protected goalSince: number = -1.0;
    protected goalTime: number = 0.0;
    protected goalStars: int = 0;
    protected solved: boolean = false;
    protected script: Stroke[] = [];
    substeps: int = DEFAULT_SUBSTEPS;
    // Time the simulation hasn't stepped through yet (under a step). It steps in fixed steps of
    // 1 / (60 substeps) s, whatever the frame rate: the pressure each step starts from is the
    // last step's (in units of dt), so a dt that changes from frame to frame (frame times can
    // alternate 0.5 / 13 ms) kicks the water apart.
    protected pendingTime: number = 0.0;
    iterations: int = DEFAULT_ITERATIONS;
    solver: int = SOLVER_MULTIGRID;
    vcycles: int = DEFAULT_VCYCLES;
    smooth: int = DEFAULT_SMOOTH;
    viscositySweeps: int = DEFAULT_VISCOSITY_SWEEPS;
    // -air 0: no air_cs (still air: gases slow to rest, as before air moved).
    air: boolean = true;
    // -bodies 0: no bodies_cs (no blocks made, none moving).
    bodies: boolean = true;
    // (tubCount's last tub's liquid temperature)
    protected tubTemp: number = 0.0;
    // The gravity (-gravity down|off|point): its mode, and its point (in cells; under 0: the grid's
    // center); the tool before the point was being placed.
    gravityMode: int = GRAVITY_DOWN;
    protected gravityX: number = -1.0;
    protected gravityY: number = -1.0;
    // Tilting: the gravity's direction across the grid (a unit vector), whether -tilt set it, and
    // the sensor's reading.
    protected tiltX: number = 0.0;
    protected tiltY: number = 1.0;
    tiltFixed: boolean = false;
    protected sensed: number[] = [0.0, 0.0, 0.0];
    protected toolBeforePlace: int = WATER;
    // handleInput's brush shape and cursor (constants[27], the gravity's mode above them).
    protected shapeWord: int = 0;
    // Sound (none with -mute, nor in tests but for -sound: the device opened, playing nothing): the
    // playback device, the events counted so far (each
    // frame's last step's, times its steps), each sound's time till it may play again.
    mute: boolean = false;
    soundCheck: boolean = false;
    protected audio: NriAudioHandle | null = null;
    protected eventTotals: int[] = [];
    protected soundCooldowns: number[] = [];
    // The grid's cells along its shorter side (-gridHeight N, MIN_GRID_HEIGHT .. DEFAULT_GRID_HEIGHT:
    // no auto quality then), and auto quality (-quality auto: the cached size, or measured; fixed:
    // off; calibrate: measured again. Unset, auto, but in a test fixed, or measured without
    // caching it for -stepBudget ms, its budget).
    gridHeight: int = DEFAULT_GRID_HEIGHT;
    gridHeightSet: boolean = false;
    quality: string = "";
    stepBudget: number = STEP_BUDGET_MS;
    protected calibrating: boolean = false;
    protected calibrationScene: int = 0;
    protected calibrationLevel: Level | null = null;
    protected qualitySum: number = 0.0;
    protected qualityCount: int = 0;
    // -test: the float sections, read back at the end (the pressure equation's residual).
    protected floatReadback: NriBufferHandle | null = null;
    // The brush mode of the scene's stroke this frame (0: none), for spark_cs.
    protected strokeBrush: int = 0;
    // -testFrames N: the test's length instead of TEST_FRAMES.
    testFrames: int = TEST_FRAMES;
    protected test: boolean = false;
    protected frameIndex: int = 0;

    constructor(protected sample: NriSampleHandle) {
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

    // The grid's size changed from oldW x oldH (its contents follow in recordStateRequests): the
    // scene's strokes still to paint moved with them, and a press in progress begun again.
    reshaped(oldW: int, oldH: int) {
        const dx = this.regridOffsetX(oldW);
        const dy = this.gridH - oldH;
        for (const stroke of this.script) {
            stroke.x0 += dx;
            stroke.x1 += dx;
            stroke.y0 += dy;
            stroke.y1 += dy;
        }
        this.wasDown = false;
    }

    // Where a grid oldW wide lands across the new one: centered (whole cells).
    regridOffsetX(oldW: int): int {
        return Math.floor((this.gridW - oldW) / 2);
    }

    // (an undo or a load keeping the grid's size keeps the view)
    setGrid(gridW: int, gridH: int) {
        if (gridW != this.gridW || gridH != this.gridH) {
            this.gridW = gridW;
            this.gridH = gridH;
            this.stride = (gridW + 1) * (gridH + 1);
            this.resetView();
        }
        this.layout();
    }

    // The whole grid in view.
    resetView() {
        this.zoom = 1.0;
        this.centerX = this.gridW * 0.5;
        this.centerY = this.gridH * 0.5;
    }

    // Zoomed in or out by notches (of ZOOM_STEP) around the pointer at (x, y): the grid point
    // under it stays there.
    zoomAt(x: number, y: number, notches: number) {
        const gx = (x - this.viewX) / this.cellPixels;
        const gy = (y - this.viewY) / this.cellPixels;
        this.zoom = Math.min(Math.max(this.zoom * Math.pow(ZOOM_STEP, notches), 1.0), MAX_ZOOM);
        const cellPixels = this.fitPixels() * this.zoom;
        this.centerX = gx - (x - this.width * 0.5) / cellPixels;
        this.centerY = gy - (y - (this.height - this.toolbarHeight) * 0.5) / cellPixels;
        this.layout();
    }

    // A cell's size, in pixels, when the whole grid fits above the toolbar.
    fitPixels(): number {
        return Math.min(this.width / this.gridW, (this.height - this.toolbarFullHeight()) / this.gridH);
    }

    // A tile's height: a share of the window's shorter side, 56 .. 160 pixels.
    toolbarTileHeight(): number {
        return Math.floor(Math.min(Math.max(Math.min(this.width, this.height) * 0.12, 56.0), 160.0));
    }

    // The tabs' row's height: under half a tile's, but room for a line of text.
    toolbarTabHeight(): number {
        return Math.floor(Math.max(this.toolbarTileHeight() * 0.42, 28.0));
    }

    // The whole toolbar's: the tabs' row and the tiles'.
    toolbarFullHeight(): number {
        return this.toolbarTileHeight() + this.toolbarTabHeight();
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

    // Whether the grid's wider than tall whatever the window's shape: a level's, and the test
    // scenes' from 4, are laid out on one (on a phone held upright, it's turned, drawn smaller).
    wantsWide(): boolean {
        const level = this.level;
        if (level) {
            return true;
        }
        return this.test && this.scene >= 4;
    }

    // The grid's size from the shape of the window above the toolbar: gridHeight cells along its
    // shorter side, up to MAX_GRID_LONG along the longer (a wider window shows margins).
    fitGrid() {
        const playHeight = this.height - this.toolbarFullHeight();
        let gridW: int = this.gridHeight;
        let gridH: int = this.gridHeight;
        if (this.width >= playHeight) {
            gridW = Math.floor(this.gridHeight * this.width / playHeight);
        } else {
            gridH = Math.floor(this.gridHeight * playHeight / this.width);
        }
        if (this.wantsWide() && gridH > gridW) {
            const turned = gridW;
            gridW = gridH;
            gridH = turned;
        }
        this.gridW = Math.min(gridW, MAX_GRID_LONG);
        this.gridH = Math.min(gridH, MAX_GRID_LONG);
        this.resetView();
        this.stride = (this.gridW + 1) * (this.gridH + 1);
        console.log(`Grid: ${this.gridW} x ${this.gridH} cells`);
    }

    // The toolbar: the tabs' row (laid out by buildUI, by their labels), and under it the group's
    // tiles, spread over the window's width, or MIN_TILE_WIDTH pixels each (no narrower than tall)
    // and scrolled sideways when they don't fit (a phone held upright); and
    // where the grid's drawn: zoom times as large as fits above it, around its view's center
    // (kept where the grid still fills the area across, or down; centered where it doesn't).
    layout() {
        this.tileHeight = this.toolbarTileHeight();
        this.tabHeight = this.toolbarTabHeight();
        this.tileWidth = Math.max(this.width / Math.max(this.groupTiles.length, 1), Math.max(MIN_TILE_WIDTH, this.tileHeight));
        this.toolbarHeight = this.tileHeight + this.tabHeight;
        const playHeight = this.height - this.toolbarHeight;
        this.cellPixels = this.fitPixels() * this.zoom;
        const halfW = this.width * 0.5 / this.cellPixels;
        const halfH = playHeight * 0.5 / this.cellPixels;
        this.centerX = this.gridW <= 2.0 * halfW ? this.gridW * 0.5 : Math.min(Math.max(this.centerX, halfW), this.gridW - halfW);
        this.centerY = this.gridH <= 2.0 * halfH ? this.gridH * 0.5 : Math.min(Math.max(this.centerY, halfH), this.gridH - halfH);
        this.viewX = this.width * 0.5 - this.centerX * this.cellPixels;
        this.viewY = playHeight * 0.5 - this.centerY * this.cellPixels;
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

    setFloat(index: int, value: number) {
        this.constants[index] = value;
    }

    setInt(index: int, value: int) {
        Nri_StoreInt32(Ref(this.constants[index]), value);
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

    // The attraction point, in the grid (its center until one's placed).
    gravityPointX(): number {
        return this.gravityX < 0.0 ? this.gridW * 0.5 : Math.min(this.gravityX, this.gridW - 1.0);
    }

    gravityPointY(): number {
        return this.gravityY < 0.0 ? this.gridH * 0.5 : Math.min(this.gravityY, this.gridH - 1.0);
    }

    barriers(commandBuffer: NriCommandBufferHandle, mask: int, before: NriBufferState, after: NriBufferState) {
        for (let i = 0; i < BUFFERS; i++) {
            if ((mask & (1 << i)) != 0) {
                Nri_CmdBufferBarrier(commandBuffer, this.buffers[i], before, after);
            }
        }
    }

    // Copies the state (STATE_BUFFERS' buffers, one after another) into snapshot, or out of it back
    // into them; snapshot is in snapshotState before and after (a readback buffer: CopyDestination).
    recordStateCopy(commandBuffer: NriCommandBufferHandle, snapshot: NriBufferHandle, toSnapshot: boolean, snapshotState: NriBufferState) {
        const liveState = toSnapshot ? NriBufferState.CopySource : NriBufferState.CopyDestination;
        const snapshotUse = toSnapshot ? NriBufferState.CopyDestination : NriBufferState.CopySource;
        if (snapshotState != snapshotUse) {
            Nri_CmdBufferBarrier(commandBuffer, snapshot, snapshotState, snapshotUse);
        }
        let offset = 0;
        for (const i of STATE_BUFFERS) {
            const buffer = this.buffers[i];
            const size = this.bufferSizes[i];
            Nri_CmdBufferBarrier(commandBuffer, buffer, NriBufferState.Storage, liveState);
            if (toSnapshot) {
                Nri_CmdCopyBufferRegion(commandBuffer, snapshot, offset, buffer, 0, size);
            } else {
                Nri_CmdCopyBufferRegion(commandBuffer, buffer, 0, snapshot, offset, size);
            }
            Nri_CmdBufferBarrier(commandBuffer, buffer, liveState, NriBufferState.Storage);
            offset += size;
        }
        if (snapshotState != snapshotUse) {
            Nri_CmdBufferBarrier(commandBuffer, snapshot, snapshotUse, snapshotState);
        }
    }

    // Before the frame's constants: the grid's size an undo or a load will leave it at. An undo
    // takes its snapshot's (even if the window has turned since: it's shown with margins rather
    // than remade, which would lose what the undo brought back); a load its save's, or, if the
    // save is the other way around from the window, the window's (and is remade to it).
    prepareStateRequests() {
        if (this.undoRequested && this.undoCount > 0) {
            this.setGrid(this.undoW[this.undoTop], this.undoH[this.undoTop]);
        }
        if (this.loadRequested) {
            this.loadRequested = false;
            const loadBuffer = this.openSave();
            if (loadBuffer) {
                this.loadBuffer = loadBuffer;
                this.loadPending = true;
                const wide = this.width >= this.height - this.toolbarHeight;
                if (wide == (this.loadW >= this.loadH)) {
                    this.setGrid(this.loadW, this.loadH);
                } else {
                    this.fitGrid();
                    this.layout();
                }
            }
        }
    }

    // The frame's requests, before it simulates: undo (the newest snapshot back), load (the save
    // file's state, after a snapshot of the current one), a regrid (the grid remade at
    // gridW x gridH, after a snapshot), a snapshot (a stroke or Clear begins), a save (the state
    // read back, written once the frame is done).
    recordStateRequests(commandBuffer: NriCommandBufferHandle) {
        let snapshotTaken = false;
        if (this.undoRequested) {
            this.undoRequested = false;
            if (this.undoCount > 0) {
                this.recordStateCopy(commandBuffer, this.undoBuffers[this.undoTop], false, NriBufferState.CopyDestination);
                this.stateW = this.undoW[this.undoTop];
                this.stateH = this.undoH[this.undoTop];
                this.undoTop = (this.undoTop + UNDO_DEPTH - 1) % UNDO_DEPTH;
                this.undoCount--;
                // The restored state stands as it was: no scene strokes or Clear still to come.
                this.script = [];
                this.needsInit = false;
                this.snapshotRequested = false;
            } else {
                this.showMessage("Nothing to undo");
            }
        }
        const loadBuffer = this.loadBuffer;
        if (this.loadPending) {
            this.loadPending = false;
            if (loadBuffer) {
                this.pushSnapshot(commandBuffer);
                snapshotTaken = true;
                this.recordStateCopy(commandBuffer, loadBuffer, false, NriBufferState.CopySource);
                this.stateW = this.loadW;
                this.stateH = this.loadH;
                this.script = [];
                this.needsInit = false;
                this.snapshotRequested = false;
                this.showMessage("Loaded");
            }
        }
        if (this.stateW != this.gridW || this.stateH != this.gridH) {
            if (!snapshotTaken) {
                this.pushSnapshot(commandBuffer);
            }
            this.recordRegrid(commandBuffer);
        }
        if (this.snapshotRequested) {
            this.snapshotRequested = false;
            this.pushSnapshot(commandBuffer);
        }
        if (this.saveRequested) {
            this.saveRequested = false;
            const device = this.device;
            if (device) {
                const saveReadback = Nri_CreateReadbackBuffer(device, this.stateSize);
                if (saveReadback) {
                    this.recordStateCopy(commandBuffer, saveReadback, true, NriBufferState.CopyDestination);
                    this.saveReadback = saveReadback;
                } else {
                    this.showMessage("Cannot save: out of memory");
                }
            }
        }
    }

    // The state into the next undo slot (over the oldest once they're all used).
    pushSnapshot(commandBuffer: NriCommandBufferHandle) {
        this.undoTop = (this.undoTop + 1) % UNDO_DEPTH;
        this.undoCount = Math.min(this.undoCount + 1, UNDO_DEPTH);
        this.undoW[this.undoTop] = this.stateW;
        this.undoH[this.undoTop] = this.stateH;
        this.recordStateCopy(commandBuffer, this.undoBuffers[this.undoTop], true, NriBufferState.CopyDestination);
    }

    // The grid the buffers hold (stateW x stateH) remade at gridW x gridH: its cells and cell
    // temperatures copied aside into the int sections (which every step remakes), then
    // regrid_grid_cs and regrid_particles_cs move them, the old grid's floor on the new one's and
    // centered across it.
    recordRegrid(commandBuffer: NriCommandBufferHandle) {
        const oldW = this.stateW;
        const oldH = this.stateH;
        const oldStride = (oldW + 1) * (oldH + 1);
        const scratch = this.buffers[1];
        const gridFloat = this.buffers[2];
        const cells = this.buffers[3];
        Nri_CmdBufferBarrier(commandBuffer, scratch, NriBufferState.Storage, NriBufferState.CopyDestination);
        Nri_CmdBufferBarrier(commandBuffer, gridFloat, NriBufferState.Storage, NriBufferState.CopySource);
        Nri_CmdBufferBarrier(commandBuffer, cells, NriBufferState.Storage, NriBufferState.CopySource);
        Nri_CmdCopyBufferRegion(commandBuffer, scratch, 0, cells, 0, oldW * oldH * 4);
        Nri_CmdCopyBufferRegion(commandBuffer, scratch, oldStride * 4, gridFloat, F_TPRE * oldStride * 4,
            CARRIED_FLOAT_SECTIONS * oldStride * 4);
        // (then the bodies, which regrid_grid_cs moves by the offset)
        Nri_CmdCopyBufferRegion(commandBuffer, scratch, (1 + CARRIED_FLOAT_SECTIONS) * oldStride * 4, gridFloat,
            F_BODY * oldStride * 4, MAX_BODIES * BODY_FLOATS * 4);
        Nri_CmdBufferBarrier(commandBuffer, scratch, NriBufferState.CopyDestination, NriBufferState.Storage);
        Nri_CmdBufferBarrier(commandBuffer, gridFloat, NriBufferState.CopySource, NriBufferState.Storage);
        Nri_CmdBufferBarrier(commandBuffer, cells, NriBufferState.CopySource, NriBufferState.Storage);

        const computeLayout = this.computeLayout;
        if (!computeLayout) {
            return;
        }
        Nri_CmdSetDescriptorPool(commandBuffer, this.descriptorPool);
        Nri_CmdSetComputePipelineLayout(commandBuffer, computeLayout);
        // (the brush's fields stand for the old grid and the offset)
        this.setInt(8, oldW);
        this.setInt(9, oldH);
        this.setInt(15, this.regridOffsetX(oldW));
        this.setInt(16, this.gridH - oldH);
        this.dispatch(commandBuffer, REGRID_GRID, this.stride, B_ALL);
        this.dispatch(commandBuffer, REGRID_PARTICLES, CAPACITY, B_ALL);
        this.setInt(8, this.tool);
        this.setInt(15, this.emitType);
        this.stateW = this.gridW;
        this.stateH = this.gridH;
        console.log(`Grid remade: ${oldW} x ${oldH} to ${this.gridW} x ${this.gridH} cells`);
    }

    // The save file's state in a buffer to copy from (CopySource) and its grid's size (loadW,
    // loadH), or null (with a message) when there's none, or it's from another version.
    openSave(): NriBufferHandle | null {
        const device = this.device;
        if (!device) {
            return null;
        }
        const file = Nri_LoadFile(SAVE_PATH);
        if (!file) {
            this.showMessage("Nothing saved yet");
            return null;
        }
        const bytes: int[] = [];
        for (let i = 0; i < SAVE_HEADER_INTS * 4; i++) {
            bytes.push(0);
        }
        Nri_CopyFileBytes(file, 0, Math.min(bytes.length, Nri_GetFileSize(file)), Ref(bytes[0]));
        const header: int[] = [];
        for (let i = 0; i < SAVE_HEADER_INTS; i++) {
            header.push(bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24));
        }
        const headerInts = header[1] == 3 ? SAVE_HEADER_INTS_3 : SAVE_HEADER_INTS;
        let loadBuffer: NriBufferHandle | null = null;
        if (header[0] != SAVE_MAGIC || (header[1] != SAVE_VERSION && header[1] != 3) || header[4] != CAPACITY
            || Nri_GetFileSize(file) != headerInts * 4 + this.stateSize
            || header[2] < 3 || header[3] < 3 || (header[2] + 1) * (header[3] + 1) > GRID_CAPACITY) {
            this.showMessage("The save is from another version");
        } else {
            this.loadW = header[2];
            this.loadH = header[3];
            this.gravityMode = header[1] == 3 ? GRAVITY_DOWN : Math.min(Math.max(header[5], 0), GRAVITY_TILT);
            this.gravityX = header[1] == 3 ? -1.0 : header[6] / 256.0;
            this.gravityY = header[1] == 3 ? -1.0 : header[7] / 256.0;
            loadBuffer = Nri_CreateStorageBufferFromFile(device, this.queue, file, headerInts * 4, this.stateSize, 4,
                NriBufferState.CopySource);
            if (!loadBuffer) {
                this.showMessage("Cannot load: out of memory");
            }
        }
        Nri_DestroyFile(file);
        return loadBuffer;
    }

    // After the frame's submission: the save written (once the GPU has read the state back), the
    // load's buffer freed.
    finishStateRequests() {
        const device = this.device;
        const saveReadback = this.saveReadback;
        const loadBuffer = this.loadBuffer;
        if (!device) {
            return;
        }
        if (saveReadback || loadBuffer) {
            Nri_DeviceWaitIdle(device);
        }
        if (saveReadback) {
            const header: int[] = [SAVE_MAGIC, SAVE_VERSION, this.gridW, this.gridH, CAPACITY, this.gravityMode,
                Math.round(this.gravityPointX() * 256.0), Math.round(this.gravityPointY() * 256.0)];
            const saved = Nri_SaveBufferToFile(saveReadback, this.stateSize, Ref(header[0]), SAVE_HEADER_INTS, SAVE_PATH) != 0;
            this.showMessage(saved ? "Saved" : "Cannot save");
            Nri_DestroyBuffer(saveReadback);
            this.saveReadback = null;
        }
        if (loadBuffer) {
            Nri_DestroyBuffer(loadBuffer);
            this.loadBuffer = null;
        }
    }

    showMessage(text: string) {
        console.log(text);
        this.message = text;
        this.messageTime = MESSAGE_TIME;
    }

    // An entry over count threads, then a barrier on the buffers in barrierMask.
    dispatch(commandBuffer: NriCommandBufferHandle, entry: int, count: int, barrierMask: int) {
        Nri_CmdSetPipeline(commandBuffer, this.pipelines[entry]);
        Nri_CmdSetComputeRootConstants(commandBuffer, 0, Ref(this.constants[0]), CONSTANTS_SIZE);
        Nri_CmdSetComputeDescriptorSet(commandBuffer, 0, this.computeSet);
        Nri_CmdDispatch(commandBuffer, Math.floor((count + GROUP_SIZE - 1) / GROUP_SIZE), 1, 1);
        this.barriers(commandBuffer, barrierMask, NriBufferState.Storage, NriBufferState.Storage);
        const profilePool = this.profilePool;
        if (profilePool) {
            if (this.profiling && this.profileEntries.length + 1 < PROFILE_QUERIES) {
                this.profileEntries.push(entry);
                Nri_CmdWriteTimestamp(commandBuffer, profilePool, this.profileEntries.length);
            }
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

    // -roundTrip: halfway, the state cleared (without the scene's strokes) and undone; then saved,
    // cleared and loaded. If either restore failed the U-tube would end empty.
    roundTripRequests(frameIndex: int) {
        const half: int = Math.floor(this.testFrames / 2);
        if (frameIndex == half) {
            this.sceneOnClear = false;
            this.snapshotRequested = true;
            this.needsInit = true;
        } else if (frameIndex == half + 1) {
            this.undoRequested = true;
        } else if (frameIndex == half + 100) {
            this.saveRequested = true;
        } else if (frameIndex == half + 101) {
            this.needsInit = true;
        } else if (frameIndex == half + 102) {
            this.loadRequested = true;
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

    // -regrid 1: halfway, the grid remade 20 cells taller (on its floor, so the water stays where it
    // is), then back; 2: turned, its width and height swapped (the U-tube cropped at its sides
    // and its divider still in the middle).
    regridRequests(frameIndex: int) {
        const half: int = Math.floor(this.testFrames / 2);
        const oldW = this.gridW;
        const oldH = this.gridH;
        if (frameIndex == half) {
            this.regridCount = CAPACITY - this.probe[0];
            if (this.regrid == 1) {
                this.setGrid(oldW, oldH + 20);
            } else {
                this.setGrid(oldH, oldW);
            }
            this.reshaped(oldW, oldH);
        } else if (frameIndex == half + 100 && this.regrid == 1) {
            this.setGrid(oldW, oldH - 20);
            this.reshaped(oldW, oldH);
        }
    }

    // A rectangle of grid fractions (0..1 across, 0..1 down) painted with tool.
    addStroke(tool: int, x0: number, y0: number, x1: number, y1: number, emit: int) {
        this.script.push(new Stroke(tool, x0 * this.gridW, y0 * this.gridH, x1 * this.gridW, y1 * this.gridH, emit));
    }

    // The starting scene's strokes: 1 the U-tube's water (its divider is init_grid_cs's), 2 a
    // showcase of the materials, 3 lava poured into a pool with an ice block in it, and next to
    // a wood block.
    // The next level of index.json's list (read when first wanted), the grid cleared for it.
    nextLevel() {
        if (this.levelNames.length == 0) {
            const reader = this.readJson("index");
            if (reader && reader.beginObject()) {
                while (reader.nextKey()) {
                    if (reader.readString() == "levels" && reader.beginArray()) {
                        while (reader.nextItem()) {
                            this.levelNames.push(reader.readString());
                        }
                    } else {
                        reader.skipValue();
                    }
                }
            }
            if (this.levelNames.length == 0) {
                this.showMessage("No levels");
                return;
            }
            this.readStars();
        }
        this.levelIndex = (this.levelIndex + 1) % this.levelNames.length;
        const level = this.readLevel(this.levelNames[this.levelIndex]);
        if (level) {
            this.startLevel(level);
            this.snapshotRequested = true;
            this.needsInit = true;
            // (on a grid wider than tall: turned, if the window's upright)
            if (this.gridW < this.gridH) {
                const oldW = this.gridW;
                const oldH = this.gridH;
                this.fitGrid();
                this.reshaped(oldW, oldH);
                this.layout();
            }
            const best = this.bestStars[this.levelIndex];
            this.showMessage(best > 0 ? `${level.name} (best ${starText(best)})` : level.name);
        }
    }

    startLevel(level: Level | null) {
        if (level) {
            this.level = level;
            this.scene = 0;
            this.sceneOnClear = true;
            this.goalReached = false;
        }
    }

    // The best stars from STARS_PATH, one for each of index.json's levels (0 for those it hasn't).
    readStars() {
        this.bestStars = [];
        for (let k = 0; k < this.levelNames.length; k++) {
            this.bestStars.push(0);
        }
        const file = Nri_LoadFile(STARS_PATH);
        if (!file) {
            return;
        }
        const bytes: int[] = [];
        const size = Nri_GetFileSize(file);
        for (let i = 0; i < size; i++) {
            bytes.push(0);
        }
        if (size > 0) {
            Nri_CopyFileBytes(file, 0, size, Ref(bytes[0]));
        }
        Nri_DestroyFile(file);
        const ints: int[] = [];
        for (let i = 0; i + 3 < size; i += 4) {
            ints.push(bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24));
        }
        if (ints.length < 2 || ints[0] != STARS_MAGIC) {
            return;
        }
        for (let k = 0; k < this.levelNames.length && k < ints[1] && 2 + k < ints.length; k++) {
            this.bestStars[k] = Math.min(Math.max(ints[2 + k], 0), 3);
        }
    }

    // The best stars, into STARS_PATH (not in tests).
    saveStars() {
        if (this.test || this.queuedFrames.length == 0) {
            return;
        }
        const ints: int[] = [STARS_MAGIC, this.bestStars.length];
        for (const stars of this.bestStars) {
            ints.push(stars);
        }
        Nri_SaveBufferToFile(this.queuedFrames[0].probeReadback, 0, Ref(ints[0]), ints.length, STARS_PATH);
    }

    // The level's goal against the count a frame's probe read (time: the level's time after that
    // frame, -1 before its strokes): reached once it's been met for its hold time, its stars
    // then (by that time), the best kept.
    checkGoal(time: number) {
        const level = this.level;
        if (!level || level.goalCount <= 0 || this.goalReached || time < 0.0) {
            return;
        }
        const count = this.probe[PROBE_GOAL];
        if (level.goalAtMost ? count > level.goalCount : count < level.goalCount) {
            this.goalSince = -1.0;
            return;
        }
        if (this.goalSince < 0.0) {
            this.goalSince = time;
        }
        if (time - this.goalSince < level.goalHold) {
            return;
        }
        this.goalReached = true;
        this.goalTime = time;
        this.goalStars = 0;
        if (level.stars.length >= 2) {
            this.goalStars = time <= level.stars[0] ? 3 : (time <= level.stars[1] ? 2 : 1);
        }
        let best = "";
        if (this.levelIndex >= 0 && this.levelIndex < this.bestStars.length) {
            if (this.goalStars > this.bestStars[this.levelIndex]) {
                this.bestStars[this.levelIndex] = this.goalStars;
                this.saveStars();
            } else if (this.bestStars[this.levelIndex] > 0) {
                best = ` (best ${starText(this.bestStars[this.levelIndex])})`;
            }
        }
        this.showMessage(`${level.name}: done in ${formatFixed(time, 1)} s! ${starText(this.goalStars)}${best}`);
    }

    // The level's clock, from when its strokes are painted, while it simulates (steps of step
    // seconds), till its goal's reached; -solve's solution painted at its time.
    advanceLevel(steps: int, step: number) {
        const level = this.level;
        if (!level || this.goalReached) {
            return;
        }
        if (this.levelTime < 0.0) {
            if (this.script.length == 0 && !this.needsInit) {
                this.levelTime = 0.0;
            }
        } else if (!this.paused) {
            this.levelTime += steps * step;
        }
        if (this.solveTime >= 0.0 && !this.solved && this.levelTime >= this.solveTime) {
            this.solved = true;
            for (const stroke of level.solution) {
                this.addStroke(stroke.tool, stroke.box[0], stroke.box[1], stroke.box[2], stroke.box[3], stroke.emit);
            }
        }
    }

    // A file of LEVEL_DIRECTORY (name.json) in a reader, or null (with a message).
    readJson(name: string): JsonReader | null {
        const file = Nri_LoadFile(`${LEVEL_DIRECTORY}${name}.json`);
        if (!file) {
            this.showMessage(`No level file ${name}.json`);
            return null;
        }
        const reader = new JsonReader();
        if (reader.resize(Nri_GetFileSize(file))) {
            Nri_CopyFileBytes(file, 0, reader.bytes.length, Ref(reader.bytes[0]));
        }
        Nri_DestroyFile(file);
        return reader;
    }

    // A level from its file, or null (with a message: what didn't read).
    readLevel(name: string): Level | null {
        const reader = this.readJson(name);
        if (!reader) {
            return null;
        }
        const level = new Level();
        let unknown = "";
        if (reader.beginObject()) {
            while (reader.nextKey()) {
                const key = reader.readString();
                if (key == "name") {
                    level.name = reader.readString();
                } else if (key == "goal" && reader.beginObject()) {
                    while (reader.nextKey()) {
                        const goalKey = reader.readString();
                        if (goalKey == "text") {
                            level.goalText = reader.readString();
                        } else if (goalKey == "material") {
                            const material = reader.readString();
                            level.goalMaterial = toolNamed(material);
                            if (level.goalMaterial < 0) {
                                unknown = material;
                            }
                        } else if (goalKey == "box") {
                            level.goalBox = reader.readNumbers();
                        } else if (goalKey == "count") {
                            level.goalCount = Math.floor(reader.readNumber());
                        } else if (goalKey == "lit") {
                            level.goalLit = reader.readBool();
                        } else if (goalKey == "atMost") {
                            level.goalAtMost = reader.readBool();
                        } else if (goalKey == "hold") {
                            level.goalHold = Math.max(reader.readNumber(), 0.0);
                        } else {
                            reader.skipValue();
                        }
                    }
                } else if (key == "stars") {
                    level.stars = reader.readNumbers();
                } else if (key == "strokes" || key == "solution") {
                    const strokeUnknown = this.readStrokes(reader, key == "strokes" ? level.strokes : level.solution);
                    if (strokeUnknown != "") {
                        unknown = strokeUnknown;
                    }
                } else {
                    reader.skipValue();
                }
            }
        }
        if (reader.error != "" || unknown != "" || (level.goalCount > 0 && level.goalBox.length != 4)) {
            this.showMessage(`${name}.json: ${reader.error != "" ? reader.error : (unknown != "" ? `no tool or material "${unknown}"` : "the goal needs a box")}`);
            return null;
        }
        console.log(`Level ${name}: ${level.name}, ${level.strokes.length} strokes`);
        return level;
    }

    // A level's array of strokes, into strokes; the name of a tool or material it doesn't know,
    // or "".
    readStrokes(reader: JsonReader, strokes: LevelStroke[]): string {
        let unknown = "";
        if (reader.beginArray()) {
            while (reader.nextItem()) {
                let tool = -1;
                let box: number[] = [];
                let emit = WATER;
                let repeat = 1;
                if (reader.beginObject()) {
                    while (reader.nextKey()) {
                        const strokeKey = reader.readString();
                        if (strokeKey == "tool") {
                            const toolName = reader.readString();
                            tool = toolNamed(toolName);
                            if (tool < 0) {
                                unknown = toolName;
                            }
                        } else if (strokeKey == "box") {
                            box = reader.readNumbers();
                        } else if (strokeKey == "emit") {
                            const emitName = reader.readString();
                            emit = toolNamed(emitName);
                            if (emit < 0) {
                                unknown = emitName;
                            }
                        } else if (strokeKey == "blow") {
                            const blow = reader.readString();
                            emit = BLOW_NAMES.indexOf(blow);
                            if (emit < 0) {
                                unknown = blow;
                            }
                        } else if (strokeKey == "repeat") {
                            repeat = Math.max(Math.floor(reader.readNumber()), 1);
                        } else {
                            reader.skipValue();
                        }
                    }
                }
                if (tool >= 0 && box.length == 4) {
                    for (let k = 0; k < repeat; k++) {
                        strokes.push(new LevelStroke(tool, box, emit));
                    }
                }
            }
        }
        return unknown;
    }

    buildScene() {
        this.script = [];
        const level = this.level;
        if (level) {
            this.goalReached = false;
            this.levelTime = -1.0;
            this.goalSince = -1.0;
            this.solved = false;
            for (const stroke of level.strokes) {
                this.addStroke(stroke.tool, stroke.box[0], stroke.box[1], stroke.box[2], stroke.box[3], stroke.emit);
            }
            return;
        }
        if (this.scene == 1) {
            this.script.push(new Stroke(WATER, 1.0, this.gridH * 0.2, this.gridW / 2 - 0.01, this.gridH - 1.0, WATER));
        } else if (this.scene == 2) {
            // A glass tank of water with oil poured over it.
            this.addStroke(GLASS, 0.04, 0.4, 0.045, 1.0, WATER);
            this.addStroke(GLASS, 0.3, 0.4, 0.305, 1.0, WATER);
            this.addStroke(WATER, 0.05, 0.6, 0.295, 1.0, WATER);
            this.addStroke(OIL, 0.05, 0.45, 0.295, 0.58, WATER);
            // Sand poured into a pile.
            this.addStroke(SAND, 0.38, 0.1, 0.45, 0.35, WATER);
            // A wood block, lit.
            this.addStroke(WOOD, 0.55, 0.8, 0.68, 1.0, WATER);
            this.addStroke(FIRE, 0.57, 0.74, 0.66, 0.8, WATER);
            // Uranium in a pool, under a wall shelf an emitter drips water from.
            this.addStroke(WALL, 0.74, 0.55, 0.745, 1.0, WATER);
            this.addStroke(WATER, 0.75, 0.75, 0.995, 1.0, WATER);
            this.addStroke(URANIUM, 0.83, 0.86, 0.9, 1.0, WATER);
            this.addStroke(EMITTER, 0.86, 0.1, 0.87, 0.12, WATER);
        } else if (this.scene == 24) {
            // Switches (one toggled on), detectors (one under falling sand), heaters (one powered).
            for (let k = 0; k < 2; k++) {
                const y = SWITCH_ROWS[k];
                this.addStroke(BATTERY, 0.05, y, 0.09, y + WIRE, WATER);
                this.addStroke(METAL, 0.09, y, SWITCH_X, y + WIRE, WATER);
                this.addStroke(SWITCH, SWITCH_X, y, SWITCH_X + 0.04, y + WIRE, WATER);
                this.addStroke(METAL, SWITCH_X + 0.04, y, LAMP_X, y + WIRE, WATER);
                this.addStroke(LAMP, LAMP_X, y, LAMP_X + 0.04, y + WIRE, WATER);
                const d = DETECTOR_ROWS[k];
                this.addStroke(DETECTOR, 0.05, d, 0.09, d + WIRE, WATER);
                this.addStroke(METAL, 0.09, d, LAMP_X, d + WIRE, WATER);
                this.addStroke(LAMP, LAMP_X, d, LAMP_X + 0.04, d + WIRE, WATER);
                const hy = 0.5 * (HEATERS[2 + 2 * k] + HEATERS[3 + 2 * k]) - 0.5 * WIRE;
                this.addStroke(k == 0 ? BATTERY : WALL, 0.6, hy, 0.64, hy + WIRE, WATER);
                this.addStroke(METAL, 0.64, hy, HEATERS[0], hy + WIRE, WATER);
                this.addStroke(HEATER, HEATERS[0], HEATERS[2 + 2 * k], HEATERS[1], HEATERS[3 + 2 * k], WATER);
            }
            this.addStroke(SPARK, SWITCH_X, SWITCH_ROWS[0], SWITCH_X + 0.04, SWITCH_ROWS[0] + WIRE, WATER);
            this.addStroke(SAND, 0.05, DETECTOR_ROWS[0] - 0.1, 0.09, DETECTOR_ROWS[0] - 0.04, WATER);
        } else if (this.scene == 23) {
            // A sponge in a tub of water, a wall block in the other; seeds into a pool, and on a ledge.
            for (let k = 0; k < 2; k++) {
                const x0 = SPONGE_TUBS[2 * k];
                const x1 = SPONGE_TUBS[2 * k + 1];
                this.addStroke(GLASS, x0 - 0.005, SPONGE_TUB_TOP, x0, 1.0, WATER);
                this.addStroke(GLASS, x1, SPONGE_TUB_TOP, x1 + 0.005, 1.0, WATER);
                this.addStroke(WATER, x0, SPONGE_WATER, x1, 1.0, WATER);
                const dx = k == 0 ? 0.0 : SPONGE_TWIN;
                this.addStroke(k == 0 ? SPONGE : WALL, SPONGE_BOX[0] + dx, SPONGE_BOX[2], SPONGE_BOX[1] + dx, SPONGE_BOX[3], WATER);
            }
            this.addStroke(GLASS, SEED_POOL[0] - 0.005, SEED_POOL[2], SEED_POOL[0], 1.0, WATER);
            this.addStroke(GLASS, SEED_POOL[1], SEED_POOL[2], SEED_POOL[1] + 0.005, 1.0, WATER);
            this.addStroke(WATER, SEED_POOL[0], SEED_POOL[3], SEED_POOL[1], 1.0, WATER);
            this.addStroke(SEED, SEED_WET[0], SEED_WET[2], SEED_WET[1], SEED_WET[3], WATER);
            this.addStroke(WALL, SEED_LEDGE[0], SEED_LEDGE[2], SEED_LEDGE[1], SEED_LEDGE[2] + 0.02, WATER);
            this.addStroke(SEED, SEED_LEDGE[0] + 0.02, SEED_LEDGE[2] - 0.04, SEED_LEDGE[1] - 0.02, SEED_LEDGE[2] - 0.01, WATER);
        } else if (this.scene == 22) {
            // Sand dropped toward a black hole, a white hole and a wall block.
            const holes = [BLACK_HOLE, WHITE_HOLE, WALL];
            for (let k = 0; k < 3; k++) {
                this.addStroke(holes[k], HOLE_XS[k], HOLE_Y[0], HOLE_XS[k] + HOLE_W, HOLE_Y[1], WATER);
                this.addStroke(SAND, HOLE_XS[k] - 0.06, HOLE_SAND[0], HOLE_XS[k] + HOLE_W + 0.06, HOLE_SAND[1], WATER);
            }
        } else if (this.scene == 21) {
            // Water dropped on a clone, and on a wall block, each in a tub.
            for (let k = 0; k < 2; k++) {
                this.addStroke(GLASS, CLONE_TUBS[2 * k] - 0.005, CLONE_TUB_TOP, CLONE_TUBS[2 * k], 1.0, WATER);
                this.addStroke(GLASS, CLONE_TUBS[2 * k + 1], CLONE_TUB_TOP, CLONE_TUBS[2 * k + 1] + 0.005, 1.0, WATER);
                const dx = k == 0 ? 0.0 : CLONE_TWIN;
                this.addStroke(k == 0 ? CLONE : WALL, CLONED[0] + dx, CLONED[2], CLONED[1] + dx, CLONED[3], WATER);
                this.addStroke(WATER, CLONED[0] + CLONE_DROP[0] + dx, CLONED[2] + CLONE_DROP[2], CLONED[1] + CLONE_DROP[1] + dx,
                    CLONED[2] + CLONE_DROP[3], WATER);
            }
        } else if (this.scene == 18) {
            // Nitroglycerin dropped into a tub, and at rest in one.
            for (let k = 0; k < 2; k++) {
                this.addStroke(GLASS, NITRO_TUBS[2 * k] - 0.005, NITRO_TOP, NITRO_TUBS[2 * k], 1.0, WATER);
                this.addStroke(GLASS, NITRO_TUBS[2 * k + 1], NITRO_TOP, NITRO_TUBS[2 * k + 1] + 0.005, 1.0, WATER);
            }
            this.addStroke(NITRO, NITRO_DROP[0], NITRO_DROP[1], NITRO_DROP[2], NITRO_DROP[3], WATER);
            this.addStroke(NITRO, NITRO_TUBS[2], 0.92, NITRO_TUBS[3], 1.0, WATER);
            // (a wall between, from the blast)
            this.addStroke(WALL, 0.48, 0.25, 0.52, 1.0, WATER);
        } else if (this.scene == 19) {
            // C-4 wired to a battery, and not.
            for (let k = 0; k < 2; k++) {
                this.addStroke(C4, C4_BLOCKS[2 * k], C4_Y[0], C4_BLOCKS[2 * k + 1], C4_Y[1], WATER);
            }
            this.addStroke(BATTERY, C4_BLOCKS[0] - 0.15, 0.4, C4_BLOCKS[0] - 0.11, 0.4 + WIRE, WATER);
            this.addStroke(METAL, C4_BLOCKS[0] - 0.11, 0.4, C4_BLOCKS[0], 0.4 + WIRE, WATER);
            // (a wall between, from the blast)
            this.addStroke(WALL, 0.48, 0.1, 0.52, 1.0, WATER);
        } else if (this.scene == 17) {
            // Thermite on metal plates, one lit.
            for (let k = 0; k < 2; k++) {
                this.addStroke(METAL, PLATES[2 * k], PLATE_Y[0], PLATES[2 * k + 1], PLATE_Y[1], WATER);
                this.addStroke(THERMITE, PLATES[2 * k] + 0.05, THERMITE_TOP, PLATES[2 * k + 1] - 0.05, PLATE_Y[0], WATER);
            }
            for (let k = 0; k < 5; k++) {
                this.addStroke(FIRE, PLATES[0] + 0.06, THERMITE_TOP - 0.02, PLATES[1] - 0.06, THERMITE_TOP + 0.02, WATER);
            }
        } else if (this.scene == 16) {
            // Hydrogen in glass boxes, one lit; fuses, one lit; coal and wood lit on top.
            for (let k = 0; k < 2; k++) {
                this.addBox(GLASS, H2_BOXES[2 * k], H2_Y[0], H2_BOXES[2 * k + 1], H2_Y[1]);
                this.addStroke(FUSE, FUSES[0], FUSES[2 + k], FUSES[1], FUSES[2 + k] + 0.02, WATER);
            }
            for (let k = 0; k < 6; k++) {
                for (let b = 0; b < 2; b++) {
                    this.addStroke(HYDROGEN, H2_BOXES[2 * b] + 0.005, H2_Y[0] + 0.005, H2_BOXES[2 * b + 1] - 0.005, H2_Y[1] - 0.005, WATER);
                }
            }
            for (let k = 0; k < 5; k++) {
                this.addStroke(FIRE, H2_BOXES[0] + 0.01, H2_Y[1] - 0.04, H2_BOXES[1] - 0.01, H2_Y[1] - 0.01, WATER);
                this.addStroke(FIRE, FUSES[0] - 0.04, FUSES[2], FUSES[0], FUSES[2] + 0.02, WATER);
            }
        } else if (this.scene == 20) {
            // Coal and wood, lit on top.
            this.addStroke(COAL, BURN_BLOCKS[0], BURN_TOP, BURN_BLOCKS[1], 1.0, WATER);
            this.addStroke(WOOD, BURN_BLOCKS[2], BURN_TOP, BURN_BLOCKS[3], 1.0, WATER);
            // (fire for 10 frames: with 5, on some grids' widths no coal was still alight at the end)
            for (let k = 0; k < 10; k++) {
                this.addStroke(FIRE, BURN_BLOCKS[0], BURN_TOP - 0.04, BURN_BLOCKS[1], BURN_TOP, WATER);
                this.addStroke(FIRE, BURN_BLOCKS[2], BURN_TOP - 0.04, BURN_BLOCKS[3], BURN_TOP, WATER);
            }
        } else if (this.scene == 15) {
            // Salt water tubs, one wired to a battery; neon tubes, one wired.
            for (let k = 0; k < 2; k++) {
                const x0 = ELECTRO_TUBS[2 * k];
                const x1 = ELECTRO_TUBS[2 * k + 1];
                this.addStroke(GLASS, x0 - 0.005, ELECTRO_Y[0], x0, ELECTRO_Y[1], WATER);
                this.addStroke(GLASS, x1, ELECTRO_Y[0], x1 + 0.005, ELECTRO_Y[1], WATER);
                this.addStroke(GLASS, x0 - 0.005, ELECTRO_Y[1] - 0.005, x1 + 0.005, ELECTRO_Y[1], WATER);
                this.addStroke(k == 0 ? BATTERY : WALL, x0 - 0.05, ELECTRO_WIRE, x0 - 0.03, ELECTRO_WIRE + WIRE, WATER);
                this.addStroke(METAL, x0 - 0.03, ELECTRO_WIRE, x0 + 0.005, ELECTRO_WIRE + WIRE, WATER);
                this.addStroke(SALT_WATER, x0, ELECTRO_Y[0] + 0.02, x1, ELECTRO_Y[1] - 0.005, WATER);
                const y0 = NEON_TUBES[2 + 2 * k];
                const y1 = NEON_TUBES[3 + 2 * k];
                this.addBox(GLASS, NEON_TUBES[0], y0, NEON_TUBES[1], y1);
                const wireY = 0.5 * (y0 + y1) - 0.5 * WIRE;
                this.addStroke(k == 0 ? BATTERY : WALL, NEON_TUBES[0] - 0.07, wireY, NEON_TUBES[0] - 0.04, wireY + WIRE, WATER);
                this.addStroke(METAL, NEON_TUBES[0] - 0.04, wireY, NEON_TUBES[0] + 0.005, wireY + WIRE, WATER);
            }
            for (let k = 0; k < 8; k++) {
                for (let b = 0; b < 2; b++) {
                    this.addStroke(NEON, NEON_TUBES[0] + 0.005, NEON_TUBES[2 + 2 * b] + 0.005, NEON_TUBES[1] - 0.005, NEON_TUBES[3 + 2 * b] - 0.005, WATER);
                }
            }
        } else if (this.scene == 14) {
            // Circuits; gunpowder on a live wire and on a ledge.
            for (let k = 0; k < 3; k++) {
                this.addCircuit(CIRCUITS[5 * k], CIRCUITS[5 * k + 1], CIRCUITS[5 * k + 2], CIRCUITS[5 * k + 3],
                    CIRCUITS[5 * k + 4], k == 1 ? SALT_WATER : WATER);
            }
            this.addStroke(BATTERY, SPARK_WIRE[0], SPARK_WIRE[2], SPARK_WIRE[0] + 0.04, SPARK_WIRE[2] + WIRE, WATER);
            this.addStroke(METAL, SPARK_WIRE[0] + 0.04, SPARK_WIRE[2], SPARK_WIRE[1], SPARK_WIRE[2] + WIRE, WATER);
            this.addStroke(GUNPOWDER, SPARK_POWDER[0], SPARK_POWDER[1], SPARK_POWDER[2], SPARK_POWDER[3], WATER);
            this.addStroke(WALL, CONTROL_POWDER[0] - 0.02, CONTROL_POWDER[4], CONTROL_POWDER[2] + 0.02, CONTROL_POWDER[4] + WIRE, WATER);
            this.addStroke(GUNPOWDER, CONTROL_POWDER[0], CONTROL_POWDER[1], CONTROL_POWDER[2], CONTROL_POWDER[3], WATER);
        } else if (this.scene == 13) {
            // Water and sand in mid-air.
            this.addStroke(WATER, BLOBS[0], BLOBS[1], BLOBS[2], BLOBS[3], WATER);
            this.addStroke(SAND, BLOBS[4], BLOBS[5], BLOBS[6], BLOBS[7], WATER);
        } else if (this.scene == 12) {
            // A wood fire under a glass ceiling. (The probe above it, for the wind there.)
            this.mouseGridX = GAS_PROBE[0] * this.gridW;
            this.mouseGridY = GAS_PROBE[1] * this.gridH;
            this.addStroke(GLASS, GAS_CEILING[0], GAS_CEILING[1], GAS_CEILING[2], GAS_CEILING[1] + 0.01, WATER);
            this.addStroke(WOOD, GAS_WOOD[0], GAS_WOOD[1], GAS_WOOD[2], 1.0, WATER);
            for (let k = 0; k < 10; k++) {
                this.addStroke(FIRE, GAS_WOOD[0], GAS_WOOD[1] - 0.04, GAS_WOOD[2], GAS_WOOD[1], WATER);
            }
        } else if (this.scene == 11) {
            // Oil and petrol lit; oil sealed away from the air.
            this.addTubs(3);
            this.addStroke(OIL, TUBS[0] + 0.005, TUB_LIQUID, TUBS[1], 1.0, WATER);
            this.addStroke(PETROL, TUBS[2] + 0.005, TUB_LIQUID, TUBS[3], 1.0, WATER);
            this.addStroke(OIL, TUBS[4] + 0.005, TUB_LIQUID, TUBS[5], 1.0, WATER);
            this.addStroke(GLASS, TUBS[4], TUB_TOP - 0.01, TUBS[5] + 0.005, TUB_TOP, WATER);
            for (let k = 0; k < 10; k++) {
                this.addStroke(FIRE, TUBS[0] + 0.03, FIRE_BAND[0], TUBS[1] - 0.03, FIRE_BAND[1], WATER);
                this.addStroke(FIRE, TUBS[2] + 0.03, FIRE_BAND[0], TUBS[3] - 0.03, FIRE_BAND[1], WATER);
            }
        } else if (this.scene == 10) {
            // Acid poured over water, and into an empty tub.
            this.addTubs(2);
            this.addStroke(WATER, TUBS[0] + 0.005, TUB_LIQUID, TUBS[1], 1.0, WATER);
            this.addStroke(ACID, TUBS[0] + 0.005, ACID_POUR[0], TUBS[1], ACID_POUR[1], WATER);
            this.addStroke(ACID, TUBS[2] + 0.005, ACID_POUR[0], TUBS[3], ACID_POUR[1], WATER);
        } else if (this.scene == 9) {
            // A block dropped into a pool floats; one standing half over a ledge tips off it.
            this.addStroke(GLASS, BODY_POOL[0] - 0.005, BODY_POOL[1], BODY_POOL[0], 1.0, WATER);
            this.addStroke(GLASS, BODY_POOL[2], BODY_POOL[1], BODY_POOL[2] + 0.005, 1.0, WATER);
            this.addStroke(WATER, BODY_POOL[0], BODY_POOL[3], BODY_POOL[2], 1.0, WATER);
            this.addStroke(WALL, LEDGE[0], LEDGE[1], LEDGE[2], 1.0, WATER);
            this.addStroke(BLOCK, FLOATER[0], FLOATER[1], FLOATER[2], FLOATER[3], WATER);
            this.addStroke(BLOCK, TIPPER[0], TIPPER[1], TIPPER[2], LEDGE[1] - 0.005, WATER);
        } else if (this.scene == 8) {
            // A fan blowing across falling sand: the grains go with the wind. (The probe a little
            // right of the fan, for the log.)
            this.mouseGridX = WIND_SAND[0] * this.gridW;
            this.mouseGridY = 0.55 * this.gridH;
            this.addStroke(FAN, WIND_FAN[0], WIND_FAN[1], WIND_FAN[0] + 0.005, WIND_FAN[2], 0);
            // (one cell: a thicker stream packs its cells, and packed sand isn't airborne)
            const ex = (Math.floor(WIND_SAND[0] * this.gridW) + 0.05) / this.gridW;
            const ey = (Math.floor(WIND_SAND[1] * this.gridH) + 0.05) / this.gridH;
            this.addStroke(EMITTER, ex, ey, ex + 0.9 / this.gridW, ey + 0.9 / this.gridH, SAND);
        } else if (this.scene == 7) {
            // A film of water on the floor: it beads up.
            this.addStroke(WATER, BEAD[0], BEAD[1], BEAD[2], 1.0, WATER);
        } else if (this.scene == 6) {
            // Water and honey let go side by side: the water runs out, the honey slumps.
            this.addStroke(GLASS, HONEY_DIVIDER, 0.2, HONEY_DIVIDER + 0.005, 1.0, WATER);
            this.addStroke(WATER, DAM[0], DAM[2], DAM[1], 1.0, WATER);
            this.addStroke(HONEY, HONEY_DIVIDER + 0.005 + DAM[0], DAM[2], HONEY_DIVIDER + 0.005 + DAM[1], 1.0, WATER);
        } else if (this.scene == 5) {
            // Gunpowder under sand, next to a pool, lit from its side.
            const x0 = GUNPOWDER_PILE[0];
            const x1 = GUNPOWDER_PILE[2];
            this.addStroke(GLASS, x1, GUNPOWDER_WALL, x1 + 0.005, 1.0, WATER);
            this.addStroke(GLASS, POOL[0], GUNPOWDER_WALL, POOL[0] + 0.005, 1.0, WATER);
            this.addStroke(WATER, x1 + 0.005, POOL[1], POOL[0], 1.0, WATER);
            this.addStroke(GUNPOWDER, x0, GUNPOWDER_PILE[1], x1, 1.0, WATER);
            this.addStroke(SAND, x0, GUNPOWDER_PILE[1] - SAND_LAYER, x1, GUNPOWDER_PILE[1], WATER);
            for (let k = 0; k < 20; k++) {
                this.addStroke(FIRE, x0 - 0.03, 0.92, x0, 1.0, WATER);
            }
        } else if (this.scene == 4) {
            // A metal bar and a stone bar, their left ends heated.
            this.addStroke(METAL, BARS[0], BARS[1], BARS[2], BARS[1] + BARS[3], WATER);
            this.addStroke(STONE, BARS[0], BARS[4], BARS[2], BARS[4] + BARS[3], WATER);
            // Acid poured over wood in a glass tub.
            this.addStroke(GLASS, ACID_TUB[0] - 0.005, ACID_TUB[1], ACID_TUB[0], 1.0, WATER);
            this.addStroke(GLASS, ACID_TUB[2], ACID_TUB[1], ACID_TUB[2] + 0.005, 1.0, WATER);
            this.addStroke(WOOD, ACID_TUB[0], ACID_TUB[3], ACID_TUB[2], 1.0, WATER);
            this.addStroke(ACID, ACID_TUB[0], ACID_TUB[1] + 0.03, ACID_TUB[2], ACID_TUB[3] - 0.08, WATER);
            this.addStroke(GLASS, SALT_TANK[0] - 0.005, SALT_TANK[1], SALT_TANK[0], 1.0, WATER);
            this.addStroke(GLASS, SALT_TANK[2], SALT_TANK[1], SALT_TANK[2] + 0.005, 1.0, WATER);
            this.addStroke(WATER, SALT_TANK[0], SALT_TANK[3], SALT_TANK[2], 1.0, WATER);
            this.addStroke(SALT, SALT_TANK[0] + 0.06, SALT_TANK[3] - SALT_POUR[0], SALT_TANK[2] - 0.06,
                SALT_TANK[3] - SALT_POUR[0] + SALT_POUR[1], WATER);
            for (let k = 0; k < HEAT_STROKES; k++) {
                this.addStroke(HEAT, BARS[0] - 0.01, BARS[1] - 0.02, BARS[0] + 0.015, BARS[4] + BARS[3] + 0.02, WATER);
            }
        } else if (this.scene == 3) {
            this.addStroke(GLASS, 0.05, 0.5, 0.055, 1.0, WATER);
            this.addStroke(GLASS, 0.55, 0.5, 0.555, 1.0, WATER);
            this.addStroke(WATER, 0.06, 0.65, 0.545, 1.0, WATER);
            this.addStroke(ICE, ICE_BLOCK[0], ICE_BLOCK[1], ICE_BLOCK[2], ICE_BLOCK[3], WATER);
            this.addStroke(LAVA, 0.33, 0.2, 0.45, 0.32, WATER);
            this.addStroke(WOOD, 0.75, 0.85, 0.85, 1.0, WATER);
            this.addStroke(LAVA, 0.64, 0.55, 0.72, 0.7, WATER);
        }
    }

    // Scenes 10 and 11's glass tubs, the first n of TUBS.
    addTubs(n: int) {
        for (let k = 0; k < n; k++) {
            this.addStroke(GLASS, TUBS[2 * k], TUB_TOP, TUBS[2 * k] + 0.005, 1.0, WATER);
            this.addStroke(GLASS, TUBS[2 * k + 1], TUB_TOP, TUBS[2 * k + 1] + 0.005, 1.0, WATER);
        }
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

    // A battery at x0 (WIRE high, from y), a metal wire to a lamp at x1; a glass tub of liquid
    // between tubX0 and tubX1 (none if under 0), the wire into it on each side.
    addCircuit(x0: number, x1: number, y: number, tubX0: number, tubX1: number, liquid: int) {
        this.addStroke(BATTERY, x0, y, x0 + 0.04, y + WIRE, WATER);
        this.addStroke(LAMP, x1, y, x1 + 0.04, y + WIRE, WATER);
        if (tubX0 < 0.0) {
            this.addStroke(METAL, x0 + 0.04, y, x1, y + WIRE, WATER);
            return;
        }
        this.addStroke(GLASS, tubX0 - 0.005, y - 0.08, tubX0, y + 0.085, WATER);
        this.addStroke(GLASS, tubX1, y - 0.08, tubX1 + 0.005, y + 0.085, WATER);
        this.addStroke(GLASS, tubX0 - 0.005, y + 0.08, tubX1 + 0.005, y + 0.085, WATER);
        this.addStroke(METAL, x0 + 0.04, y, tubX0 + 0.005, y + WIRE, WATER);
        this.addStroke(METAL, tubX1 - 0.005, y, x1, y + WIRE, WATER);
        this.addStroke(liquid, tubX0, y - 0.07, tubX1, y + 0.08, WATER);
    }
    // A box's outline (in fractions of the grid), a cell or so thick.
    addBox(material: int, x0: number, y0: number, x1: number, y1: number) {
        this.addStroke(material, x0, y0, x1, y0 + 0.01, WATER);
        this.addStroke(material, x0, y1 - 0.01, x1, y1, WATER);
        this.addStroke(material, x0, y0, x0 + 0.005, y1, WATER);
        this.addStroke(material, x1 - 0.005, y0, x1, y1, WATER);
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

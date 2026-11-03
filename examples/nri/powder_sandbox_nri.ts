/// <reference path="../../core/nri/nri_interop.d.ts" />
import { formatFixed } from "../../core/text_format";

namespace PowderSandboxNri {
    // A falling-sand sandbox in the spirit of The Powder Toy, with real fluid physics: pick a
    // material from the toolbar and paint with the mouse or a finger. Liquids and sand are FLIP
    // particles with an incompressible pressure solve (water levels out in connected vessels), fire,
    // smoke and steam rise, uranium gives off neutrons and heat, and temperature is tracked
    // everywhere. The simulation and drawing are powder_sandbox.hlsl's; this file runs them with NRI
    // and draws the toolbar with NRIFramework's ImGui.

    const WINDOW_TITLE = "NRI Example: Powder Sandbox";

    // Test mode: the U-tube (water poured on one side of a glass divider short of the floor) for
    // 30 seconds at 60 steps a second (the sloshing takes about that long to die down); both sides
    // must end at the same level.
    const TEST_FRAMES = 1800;

    // The particle slots, and the grid's shorter side in cells (its longer side follows the window's
    // shape, up to MAX_GRID_LONG cells). The grid's buffers hold GRID_CAPACITY elements a section,
    // enough for either orientation (a section is (gridW + 1) * (gridH + 1)), so turning a phone
    // remakes the grid in the same buffers.
    const CAPACITY = 1 << 18;
    const DEFAULT_GRID_HEIGHT = 144;
    const MAX_GRID_LONG = 432;
    const GRID_CAPACITY = (DEFAULT_GRID_HEIGHT + 1) * (MAX_GRID_LONG + 1);
    // A toolbar tile's narrowest (its label in ImGui's default font fits).
    const MIN_TILE_WIDTH = 72.0;
    // How far (in pixels) a press on the toolbar moves before it scrolls it instead of tapping a tile.
    const DRAG_THRESHOLD = 8.0;
    const GROUP_SIZE = 256;
    // SandboxConstants: 32 floats or uints.
    const CONSTANTS_FLOATS = 32;
    const CONSTANTS_SIZE = CONSTANTS_FLOATS * 4;
    // powder_sandbox.hlsl's gridInt and gridFloat sections, and u_Alloc's free list's start.
    const INT_SECTIONS = 17;
    const FLOAT_SECTIONS = 12;
    const ALLOC_LIST = 16;
    const I_COUNT = 6;
    // The float sections a regrid carries over (the rest the next step remakes): F_TPRE .. F_LIFE,
    // the cell temperatures and life.
    const F_TPRE = 8;
    const CARRIED_FLOAT_SECTIONS = 4;
    // struct Particle: 8 floats.
    const PARTICLE_SIZE = 32;
    // The HUD's readout: u_Alloc's first 16 ints (free slots, then probe_cs's).
    const PROBE_INTS = 16;

    // Cells per second squared, down.
    const GRAVITY = 300.0;
    const FLIP_RATIO = 0.95;
    const SOR_OMEGA = 1.6;
    const DEFAULT_SUBSTEPS = 3;
    const DEFAULT_ITERATIONS = 40;
    // The pressure solvers: SOR (-iterations red-black sweeps over the grid), or multigrid
    // (-vcycles V-cycles, -smooth sweeps on each level going down and again coming up; its
    // smoothing isn't over-relaxed). Its coarsest level is the first of at most MG_COARSE_CELLS cells
    // (powder_sandbox.hlsl's).
    const SOLVER_SOR = 0;
    const SOLVER_MULTIGRID = 1;
    const DEFAULT_VCYCLES = 1;
    const DEFAULT_SMOOTH = 2;
    const MG_COARSE_CELLS = 256;

    // Materials and tools (powder_sandbox.hlsl's numbers).
    const WATER = 1;
    const OIL = 2;
    const SAND = 3;
    const FIRE = 4;
    const LAVA = 8;
    const WALL = 16;
    const GLASS = 17;
    const WOOD = 18;
    const URANIUM = 19;
    const EMITTER = 20;
    const ICE = 21;
    const STONE = 22;
    const ERASE = 32;
    const HEAT = 33;
    const COOL = 34;

    // The compute entries, in this order.
    const INIT_GRID = 0;
    const INIT_PARTICLES = 1;
    const CLEAR = 2;
    const P2G = 3;
    const GRID = 4;
    const HEAT_SOURCE = 5;
    const HEAT_DIFFUSE = 6;
    const DIVERGENCE = 7;
    const PRESSURE = 8;
    const PROJECT = 9;
    const G2P = 10;
    const SPAWN = 11;
    const PROBE = 12;
    const REGRID_GRID = 13;
    const REGRID_PARTICLES = 14;
    const MG_SETUP = 15;
    const MG_SMOOTH = 16;
    const MG_RESTRICT = 17;
    const MG_PROLONG = 18;
    const MG_COARSE = 19;
    const ENTRIES = ["init_grid_cs", "init_particles_cs", "clear_cs", "p2g_cs", "grid_cs", "heat_source_cs", "heat_diffuse_cs",
        "divergence_cs", "pressure_cs", "project_cs", "g2p_cs", "spawn_cs", "probe_cs", "regrid_grid_cs",
        "regrid_particles_cs", "mg_setup_cs", "mg_smooth_cs", "mg_restrict_cs", "mg_prolong_cs", "mg_coarse_cs"];

    // The buffers' barrier bits.
    const B_PARTICLES = 1;
    const B_GRID_INT = 2;
    const B_GRID_FLOAT = 4;
    const B_CELLS = 8;
    const B_ALLOC = 16;
    const B_MG = 32;
    const B_ALL = 63;
    const BUFFERS = 6;

    // The toolbar: a tile per tool, then the actions.
    class Tile {
        constructor(public label: string, public tool: int, public r: number, public g: number, public b: number) {
        }
    }
    const ACTION_SMALLER = 100;
    const ACTION_LARGER = 101;
    const ACTION_PAUSE = 102;
    const ACTION_VIEW = 103;
    const ACTION_CLEAR = 104;
    const ACTION_SHAPE = 105;
    const ACTION_UNDO = 106;
    const ACTION_SAVE = 107;
    const ACTION_LOAD = 108;

    // The simulation's state, for undo and saves: the particles, the grid's float sections (the
    // temperatures, the pressure the next step starts from, burning and melting), the cells, the free
    // list (this.buffers' indices), one after another. The int sections are counts every step
    // remakes.
    const STATE_BUFFERS = [0, 2, 3, 4];
    // Snapshots taken as strokes begin (and before Clear, Load and a regrid), newest restored first.
    const UNDO_DEPTH = 4;
    // The save file (in the executable's directory; the app's data directory on Android): a header
    // (SAVE_MAGIC, SAVE_VERSION, the grid's width and height, the particle slots), then the state.
    // Version 2: the grid's buffers at GRID_CAPACITY (version 1's were the grid's own size).
    const SAVE_PATH = "powder_sandbox.save";
    const SAVE_MAGIC = 0x53445750;
    const SAVE_VERSION = 2;
    const SAVE_HEADER_INTS = 5;
    // How long a message (saved, loaded, nothing to undo) shows, in seconds.
    const MESSAGE_TIME = 2.5;
    // GLFW's key codes.
    const KEY_Z = 90;
    const KEY_LEFT_CONTROL = 341;
    const KEY_RIGHT_CONTROL = 345;
    const VIEW_NAMES = ["Materials", "Pressure", "Temperature"];
    // Scene 3's ice block, in grid fractions (x0, y0, x1, y1).
    const ICE_BLOCK = [0.12, 0.5, 0.2, 0.72];
    // The brush's shapes: circle and square paint along the pointer's path; line and box paint, on
    // release, the line (brush-wide) or the rectangle from where the press began.
    const SHAPE_CIRCLE = 0;
    const SHAPE_SQUARE = 1;
    const SHAPE_LINE = 2;
    const SHAPE_BOX = 3;
    const SHAPE_NAMES = ["Circle", "Square", "Line", "Box"];

    // A multigrid level's width or height (level 0's is the grid's), each half the last's (rounded up).
    function levelSize(size: int, level: int): int {
        let s = size;
        for (let l = 0; l < level; l++) {
            s = Math.floor((s + 1) / 2);
        }
        return s;
    }

    // The levels a gridW x gridH grid's multigrid has: down to the first of at most MG_COARSE_CELLS.
    function levelCount(gridW: int, gridH: int): int {
        let levels = 1;
        while (levelSize(gridW, levels - 1) * levelSize(gridH, levels - 1) > MG_COARSE_CELLS) {
            levels++;
        }
        return levels;
    }

    // The floats u_Multigrid's levels 1 and up take (powder_sandbox.hlsl's mgLevel).
    function multigridFloats(gridW: int, gridH: int): int {
        let floats = 0;
        const levels = levelCount(gridW, gridH);
        for (let l = 1; l < levels; l++) {
            const w = levelSize(gridW, l);
            const h = levelSize(gridH, l);
            floats += 3 * w * h + (w + 1) * h + w * (h + 1);
        }
        return floats;
    }

    function materialName(material: int): string {
        if (material == 1) { return "water"; }
        if (material == 2) { return "oil"; }
        if (material == 3) { return "sand"; }
        if (material == 4) { return "fire"; }
        if (material == 5) { return "smoke"; }
        if (material == 6) { return "steam"; }
        if (material == 7) { return "neutron"; }
        if (material == 8) { return "lava"; }
        if (material == 16) { return "wall"; }
        if (material == 17) { return "glass"; }
        if (material == 18) { return "wood"; }
        if (material == 19) { return "uranium"; }
        if (material == 20) { return "emitter"; }
        if (material == 21) { return "ice"; }
        if (material == 22) { return "stone"; }
        return "air";
    }

    // A rectangle a scene paints with a tool (in cells); emit: an emitter's material.
    class Stroke {
        constructor(public tool: int, public x0: number, public y0: number, public x1: number, public y1: number, public emit: int) {
        }
    }

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into, where it reads the HUD's probe back, and the GPU's
    // timestamps around its simulation (and how many steps it took), read when its turn comes again.
    class QueuedFrame {
        public timedSteps: int = -1;
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public probeReadback: NriBufferHandle, public timestampReadback: NriBufferHandle | null) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    class PowderSandbox {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private viewFormat: NriFormat = NriFormat.Unknown;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private computeLayout: NriPipelineLayoutHandle | null = null;
        private drawLayout: NriPipelineLayoutHandle | null = null;
        private pipelines: NriPipelineHandle[] = [];
        private drawPipeline: NriPipelineHandle | null = null;
        private imgui: boolean = false;

        // u0 .. u4 of the compute entries, t0 .. t2 of the display.
        private buffers: NriBufferHandle[] = [];
        private storageViews: NriDescriptorHandle[] = [];
        private shaderViews: NriDescriptorHandle[] = [];
        // Their descriptor sets (plain sets, not root descriptors: Vulkan's need push descriptors,
        // which many Android devices lack).
        private descriptorPool: NriDescriptorPoolHandle;
        private computeSet: NriDescriptorSetHandle;
        private drawSet: NriDescriptorSetHandle;
        private testReadback: NriBufferHandle | null = null;
        private cellsReadback: NriBufferHandle | null = null;
        // -test: the last frame, read back.
        private frameReadback: NriBufferHandle | null = null;
        // The byte sizes of this.buffers, and of the state (STATE_BUFFERS' together).
        private bufferSizes: int[] = [];
        private stateSize: int = 0;
        // Undo: UNDO_DEPTH snapshot buffers (in CopyDestination between uses), the newest's index and
        // how many hold a state.
        private undoBuffers: NriBufferHandle[] = [];
        private undoTop: int = 0;
        private undoCount: int = 0;
        // The grid's size each snapshot was taken at.
        private undoW: int[] = [];
        private undoH: int[] = [];
        // What the next frame does to the state before simulating: take a snapshot, restore the
        // newest, save it, load the save.
        private snapshotRequested: boolean = false;
        private undoRequested: boolean = false;
        private saveRequested: boolean = false;
        private loadRequested: boolean = false;
        // This frame's save (read back, written once the frame is done) or load (uploaded from the
        // file).
        private saveReadback: NriBufferHandle | null = null;
        private loadBuffer: NriBufferHandle | null = null;
        // The loaded save's grid size, and whether it's still to be copied in.
        private loadW: int = 0;
        private loadH: int = 0;
        private loadPending: boolean = false;
        private message: string = "";
        private messageTime: number = 0.0;
        // -roundTrip (a test): halfway through, the state is cleared and undone, then saved, cleared
        // and loaded; the U-tube must still level out.
        roundTrip: boolean = false;
        // -regrid N (a test): halfway through, the grid remade 1 taller, and back 100 frames later
        // (nothing may be lost); 2 turned (its width and height swapped), cropping it.
        regrid: int = 0;
        private regridCount: int = 0;
        // Whether a Clear repaints the scene's strokes (the round trip's doesn't).
        private sceneOnClear: boolean = true;
        private rowPitch: int = 0;

        private width: int = 0;
        private height: int = 0;
        private gridW: int = 0;
        private gridH: int = DEFAULT_GRID_HEIGHT;
        private stride: int = 0;
        // The size of the grid the buffers hold, as this frame's recording goes: when it's not
        // gridW x gridH, recordStateRequests remakes it (the window turned).
        private stateW: int = 0;
        private stateH: int = 0;
        private toolbarHeight: number = 0.0;
        private tileWidth: number = MIN_TILE_WIDTH;
        private tileHeight: number = 56.0;
        // The toolbar's row scrolled left by this many pixels (0 .. maxScroll()).
        private toolbarScroll: number = 0.0;
        private viewX: number = 0.0;
        private viewY: number = 0.0;
        private cellPixels: number = 1.0;

        private tiles: Tile[] = [];
        private tool: int = WATER;
        private emitType: int = WATER;
        private brushRadius: number = 3.0;
        private brushShape: int = SHAPE_CIRCLE;
        private paused: boolean = false;
        // -view N: 0 materials, 1 pressure, 2 temperature.
        overlay: int = 0;
        private needsInit: boolean = true;
        private time: number = 0.0;
        private frameRate: number = 0.0;
        // The GPU's time for the simulation (a queued frame's two timestamps), the last frame's that
        // stepped, per step.
        private queryPool: NriQueryPoolHandle | null = null;
        private querySize: int = 8;
        private stepMs: number = 0.0;
        private fpsFrames: int = 0;
        private fpsTime: number = 0.0;

        // The pointer: down last frame, where (in cells), whether the press began on the toolbar; a
        // press there: where it began, the scroll then, whether it has dragged the row yet.
        private wasDown: boolean = false;
        private zWasDown: boolean = false;
        private pressOnToolbar: boolean = false;
        private pressX: number = 0.0;
        private pressScroll: number = 0.0;
        private dragging: boolean = false;
        private lastGridX: number = 0.0;
        private lastGridY: number = 0.0;
        private mouseGridX: number = 0.0;
        private mouseGridY: number = 0.0;
        // Where a press on the grid began (in cells): a line's or a box's first corner.
        private anchorX: number = 0.0;
        private anchorY: number = 0.0;

        private constants: f32[] = [];
        private probe: int[] = [];
        private probeFloats: f32[] = [];

        // Options: -scene N (1, or -utube: the test's U-tube; 2 a showcase of the materials; 3 lava,
        // ice and stone);
        // -substeps N; -solver sor|multigrid, -iterations N (SOR's sweeps), -vcycles N, -smooth N.
        scene: int = 0;
        private script: Stroke[] = [];
        substeps: int = DEFAULT_SUBSTEPS;
        // Time the simulation hasn't stepped through yet (under a step). It steps in fixed steps of
        // 1 / (60 substeps) s, whatever the frame rate: the pressure each step starts from is the
        // last step's (in units of dt), so a dt that changes from frame to frame (frame times can
        // alternate 0.5 / 13 ms) kicks the water apart.
        private pendingTime: number = 0.0;
        iterations: int = DEFAULT_ITERATIONS;
        solver: int = SOLVER_MULTIGRID;
        vcycles: int = DEFAULT_VCYCLES;
        smooth: int = DEFAULT_SMOOTH;
        // -test: the float sections, read back at the end (the pressure equation's residual).
        private floatReadback: NriBufferHandle | null = null;
        // -testFrames N: the test's length instead of TEST_FRAMES.
        testFrames: int = TEST_FRAMES;
        private test: boolean = false;
        private frameIndex: int = 0;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < CONSTANTS_FLOATS; i++) {
                this.constants.push(0.0);
            }
            for (let i = 0; i < PROBE_INTS; i++) {
                this.probe.push(0);
                this.probeFloats.push(0.0);
            }
            this.tiles.push(new Tile("Water", WATER, 0.12, 0.38, 0.9));
            this.tiles.push(new Tile("Oil", OIL, 0.72, 0.5, 0.12));
            this.tiles.push(new Tile("Sand", SAND, 0.86, 0.74, 0.44));
            this.tiles.push(new Tile("Lava", LAVA, 0.85, 0.25, 0.05));
            this.tiles.push(new Tile("Fire", FIRE, 1.0, 0.45, 0.1));
            this.tiles.push(new Tile("Wall", WALL, 0.42, 0.42, 0.45));
            this.tiles.push(new Tile("Glass", GLASS, 0.6, 0.85, 0.92));
            this.tiles.push(new Tile("Wood", WOOD, 0.45, 0.28, 0.12));
            this.tiles.push(new Tile("Ice", ICE, 0.75, 0.92, 1.0));
            this.tiles.push(new Tile("Uranium", URANIUM, 0.25, 0.65, 0.2));
            this.tiles.push(new Tile("Emitter", EMITTER, 0.62, 0.22, 0.62));
            this.tiles.push(new Tile("Heat", HEAT, 0.95, 0.25, 0.15));
            this.tiles.push(new Tile("Cool", COOL, 0.3, 0.6, 1.0));
            this.tiles.push(new Tile("Erase", ERASE, 0.35, 0.12, 0.12));
            this.tiles.push(new Tile("Shape", ACTION_SHAPE, 0.3, 0.3, 0.3));
            this.tiles.push(new Tile("Brush -", ACTION_SMALLER, 0.3, 0.3, 0.3));
            this.tiles.push(new Tile("Brush +", ACTION_LARGER, 0.3, 0.3, 0.3));
            this.tiles.push(new Tile("Pause", ACTION_PAUSE, 0.3, 0.3, 0.3));
            this.tiles.push(new Tile("View", ACTION_VIEW, 0.3, 0.3, 0.3));
            this.tiles.push(new Tile("Clear", ACTION_CLEAR, 0.3, 0.3, 0.3));
            this.tiles.push(new Tile("Undo", ACTION_UNDO, 0.3, 0.3, 0.3));
            this.tiles.push(new Tile("Save", ACTION_SAVE, 0.3, 0.3, 0.3));
            this.tiles.push(new Tile("Load", ACTION_LOAD, 0.3, 0.3, 0.3));
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
            if (this.test && this.scene == 0) {
                this.scene = 1;
            }

            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.createSwapChain(device);
            const format = this.viewFormat;
            this.fitGrid();
            this.layout();
            this.stateW = this.gridW;
            this.stateH = this.gridH;

            // Queued frames
            const queryPool = Nri_CreateTimestampQueryPool(device, 2 * queuedFrameNum);
            this.queryPool = queryPool;
            if (queryPool) {
                this.querySize = Nri_GetQuerySize(queryPool);
            }
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const probeReadback = Nri_CreateReadbackBuffer(device, PROBE_INTS * 4);
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
            const multigridSize = Math.max(multigridFloats(MAX_GRID_LONG, DEFAULT_GRID_HEIGHT),
                multigridFloats(DEFAULT_GRID_HEIGHT, MAX_GRID_LONG)) * 4;
            const sizes = [CAPACITY * PARTICLE_SIZE, INT_SECTIONS * GRID_CAPACITY * 4, FLOAT_SECTIONS * GRID_CAPACITY * 4,
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
                this.testReadback = Nri_CreateReadbackBuffer(device, INT_SECTIONS * GRID_CAPACITY * 4);
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
            const wide = this.width >= this.height - this.toolbarTileHeight();
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

        setGrid(gridW: int, gridH: int) {
            this.gridW = gridW;
            this.gridH = gridH;
            this.stride = (gridW + 1) * (gridH + 1);
            this.layout();
        }

        // The toolbar's height: a share of the window's shorter side, 56 .. 160 pixels.
        toolbarTileHeight(): number {
            return Math.floor(Math.min(Math.max(Math.min(this.width, this.height) * 0.12, 56.0), 160.0));
        }

        // The grid's size from the shape of the window above the toolbar: DEFAULT_GRID_HEIGHT cells
        // along its shorter side, up to MAX_GRID_LONG along the longer (a wider window shows margins).
        fitGrid() {
            const playHeight = this.height - this.toolbarTileHeight();
            let gridW: int = DEFAULT_GRID_HEIGHT;
            let gridH: int = DEFAULT_GRID_HEIGHT;
            if (this.width >= playHeight) {
                gridW = Math.floor(DEFAULT_GRID_HEIGHT * this.width / playHeight);
            } else {
                gridH = Math.floor(DEFAULT_GRID_HEIGHT * playHeight / this.width);
            }
            this.gridW = Math.min(gridW, MAX_GRID_LONG);
            this.gridH = Math.min(gridH, MAX_GRID_LONG);
            this.stride = (this.gridW + 1) * (this.gridH + 1);
            console.log(`Grid: ${this.gridW} x ${this.gridH} cells`);
        }

        // The toolbar: one row of tiles, spread over the window's width, or MIN_TILE_WIDTH pixels each
        // (no narrower than tall) and scrolled sideways when they don't fit (a phone held upright); and
        // where the grid's drawn: as large as fits above it, centered.
        layout() {
            this.tileHeight = this.toolbarTileHeight();
            this.tileWidth = Math.max(this.width / this.tiles.length, Math.max(MIN_TILE_WIDTH, this.tileHeight));
            this.toolbarHeight = this.tileHeight;
            const playHeight = this.height - this.toolbarHeight;
            this.cellPixels = Math.min(this.width / this.gridW, playHeight / this.gridH);
            this.viewX = (this.width - this.gridW * this.cellPixels) * 0.5;
            this.viewY = (playHeight - this.gridH * this.cellPixels) * 0.5;
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // How far the toolbar's row scrolls.
        maxScroll(): number {
            return Math.max(this.tiles.length * this.tileWidth - this.width, 0.0);
        }

        scrollToolbar(scroll: number) {
            this.toolbarScroll = Math.min(Math.max(scroll, 0.0), this.maxScroll());
        }

        // A toolbar tile was tapped.
        onTile(tile: Tile) {
            const action = tile.tool;
            if (action == ACTION_SMALLER) {
                this.brushRadius = Math.max(this.brushRadius - 1.0, 0.5);
            } else if (action == ACTION_LARGER) {
                this.brushRadius = Math.min(this.brushRadius + 1.0, 30.0);
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
            } else if (action == ACTION_SHAPE) {
                this.brushShape = (this.brushShape + 1) % SHAPE_NAMES.length;
            } else {
                this.tool = action;
                // Emitters emit the liquid, powder or fire picked last.
                if (action == WATER || action == OIL || action == SAND || action == LAVA || action == FIRE) {
                    this.emitType = action;
                }
            }
        }

        // The pointer (mouse or touch): taps on the toolbar, strokes of the brush on the grid. The
        // brush's constants for this frame.
        handleInput(): int {
            const mx = Nri_GetMouseX(this.sample);
            const my = Nri_GetMouseY(this.sample);
            const down = Nri_IsButtonPressed(this.sample, 0) != 0;
            const gx = (mx - this.viewX) / this.cellPixels;
            const gy = (my - this.viewY) / this.cellPixels;
            this.mouseGridX = gx;
            this.mouseGridY = gy;

            // The wheel over the toolbar scrolls it (half a tile a notch), over the grid sizes the brush.
            const wheel = Nri_GetMouseWheel(this.sample);
            const overToolbar = my >= this.height - this.toolbarHeight;
            if (overToolbar && wheel != 0.0) {
                this.scrollToolbar(this.toolbarScroll + (wheel > 0.0 ? -0.5 : 0.5) * this.tileWidth);
            } else if (wheel > 0.0) {
                this.brushRadius = Math.min(this.brushRadius + 1.0, 30.0);
            } else if (wheel < 0.0) {
                this.brushRadius = Math.max(this.brushRadius - 1.0, 0.5);
            }
            if (Nri_IsKeyToggled(this.sample, NriKey.Space) != 0) {
                this.paused = !this.paused;
            }
            // Ctrl+Z (each press of Z while Control is down).
            const control = Nri_IsKeyPressed(this.sample, KEY_LEFT_CONTROL) != 0 || Nri_IsKeyPressed(this.sample, KEY_RIGHT_CONTROL) != 0;
            const z = Nri_IsKeyPressed(this.sample, KEY_Z) != 0;
            if (control && z && !this.zWasDown) {
                this.undoRequested = true;
            }
            this.zWasDown = z;

            let brushMode = 0;
            if (down && !this.wasDown) {
                this.pressOnToolbar = overToolbar;
                // A stroke begins: what it changes can be undone.
                if (!overToolbar) {
                    this.snapshotRequested = true;
                }
                this.pressX = mx;
                this.pressScroll = this.toolbarScroll;
                this.dragging = false;
                this.lastGridX = gx;
                this.lastGridY = gy;
                this.anchorX = gx;
                this.anchorY = gy;
            }
            // On the toolbar: a drag scrolls the row, a release that didn't drag taps the tile there.
            if (this.pressOnToolbar) {
                if (down) {
                    if (Math.abs(mx - this.pressX) > DRAG_THRESHOLD) {
                        this.dragging = true;
                    }
                    if (this.dragging) {
                        this.scrollToolbar(this.pressScroll - (mx - this.pressX));
                    }
                } else if (this.wasDown && !this.dragging) {
                    const index: int = Math.floor((this.pressX + this.toolbarScroll) / this.tileWidth);
                    if (index >= 0 && index < this.tiles.length) {
                        this.onTile(this.tiles[index]);
                    }
                }
            }
            // On the grid: circles and squares paint along the path; lines and boxes when released.
            const stretches = this.brushShape == SHAPE_LINE || this.brushShape == SHAPE_BOX;
            const pressOnGrid = this.wasDown && !this.pressOnToolbar;
            if (down && !this.pressOnToolbar && !stretches) {
                brushMode = 1;
                this.setFloat(10, this.lastGridX);
                this.setFloat(11, this.lastGridY);
                this.setFloat(12, gx);
                this.setFloat(13, gy);
                this.lastGridX = gx;
                this.lastGridY = gy;
            } else if (!down && pressOnGrid && stretches) {
                brushMode = this.brushShape == SHAPE_BOX ? 2 : 1;
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
            if (down && !this.pressOnToolbar && stretches) {
                cursorMode = this.brushShape == SHAPE_BOX ? 2 : 1;
                cursorX = this.anchorX;
                cursorY = this.anchorY;
            } else if (this.brushShape == SHAPE_BOX) {
                cursorMode = 2;
            }
            if (overToolbar || (down && this.pressOnToolbar)) {
                cursorMode = 0;
            }
            const shape = this.brushShape == SHAPE_SQUARE ? 1 : 0;
            this.setInt(27, shape | (cursorMode << 4));
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
            this.setInt(15, this.emitType);
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
            Nri_CopyFileBytes(file, 0, bytes.length, Ref(bytes[0]));
            const header: int[] = [];
            for (let i = 0; i < SAVE_HEADER_INTS; i++) {
                header.push(bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24));
            }
            let loadBuffer: NriBufferHandle | null = null;
            if (header[0] != SAVE_MAGIC || header[1] != SAVE_VERSION || header[4] != CAPACITY
                || Nri_GetFileSize(file) != SAVE_HEADER_INTS * 4 + this.stateSize
                || header[2] < 3 || header[3] < 3 || (header[2] + 1) * (header[3] + 1) > GRID_CAPACITY) {
                this.showMessage("The save is from another version");
            } else {
                this.loadW = header[2];
                this.loadH = header[3];
                loadBuffer = Nri_CreateStorageBufferFromFile(device, this.queue, file, SAVE_HEADER_INTS * 4, this.stateSize, 4,
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
                const header: int[] = [SAVE_MAGIC, SAVE_VERSION, this.gridW, this.gridH, CAPACITY];
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
            if (brushMode == 0 && this.script.length > 0) {
                const stroke = this.script[0];
                this.script.splice(0, 1);
                brushMode = 2;
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
                this.dispatch(commandBuffer, HEAT_SOURCE, cells, B_ALL);
                this.dispatch(commandBuffer, HEAT_DIFFUSE, cells, B_ALL);
                this.dispatch(commandBuffer, DIVERGENCE, cells, B_ALL);
                this.recordPressure(commandBuffer);
                this.dispatch(commandBuffer, PROJECT, this.stride, B_ALL);
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
        buildScene() {
            this.script = [];
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

        // The toolbar and the readout.
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            const tileWidth = this.tileWidth;
            const pad = Math.max(2.0, Math.min(tileWidth, this.tileHeight) * 0.06);
            const labelHeight = Nri_ImguiGetFontSize() + 4.0;
            const top = this.height - this.toolbarHeight;
            const bottom = this.height;
            Nri_ImguiDrawRect(0.0, top, this.width, bottom, 0.08, 0.08, 0.1, 1.0);
            for (let i = 0; i < this.tiles.length; i++) {
                const tile = this.tiles[i];
                const x0 = i * tileWidth - this.toolbarScroll;
                if (x0 + tileWidth <= 0.0 || x0 >= this.width) {
                    continue;
                }
                const selected = tile.tool == this.tool || (tile.tool == ACTION_PAUSE && this.paused);
                if (selected) {
                    Nri_ImguiDrawRect(x0 + 1.0, top + 1.0, x0 + tileWidth - 1.0, bottom - 1.0, 0.95, 0.95, 0.95, 1.0);
                }
                Nri_ImguiDrawRect(x0 + pad, top + pad, x0 + tileWidth - pad, bottom - pad - labelHeight, tile.r, tile.g, tile.b, 1.0);
                let label = tile.label;
                if (tile.tool == ACTION_PAUSE && this.paused) {
                    label = "Play";
                } else if (tile.tool == ACTION_SHAPE) {
                    label = SHAPE_NAMES[this.brushShape];
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
            // When the row scrolls, a bar along its top: how much of it shows, and where.
            if (this.maxScroll() > 0.0) {
                const total = this.tiles.length * tileWidth;
                const barX0 = this.toolbarScroll / total * this.width;
                const barX1 = (this.toolbarScroll + this.width) / total * this.width;
                Nri_ImguiDrawRect(barX0, top, barX1, top + 3.0, 0.7, 0.7, 0.75, 1.0);
            }

            // Particles in use, the brush, the view; the cell under the pointer.
            const used = CAPACITY - this.probe[0];
            let y = this.drawWrapped([`${formatFixed(this.frameRate, 0)} fps`, `step ${formatFixed(this.stepMs, 2)} ms`,
                `particles ${used} / ${CAPACITY}`,
                `brush ${formatFixed(this.brushRadius, 0)} ${SHAPE_NAMES[this.brushShape]}`, `view: ${VIEW_NAMES[this.overlay]}`,
                this.paused ? "PAUSED" : ""], 6.0, labelHeight, 1.0);
            const cell = this.probe[3] & 0xFF;
            let contents = materialName(cell);
            if (cell < WALL) {
                const names = ["water", "oil", "sand", "fire", "smoke", "steam", "neutron", "lava"];
                contents = "";
                for (let m = 0; m < names.length; m++) {
                    const n = this.probe[4 + m];
                    if (n > 0) {
                        contents = `${contents}${contents == "" ? "" : ", "}${n} ${names[m]}`;
                    }
                }
                if (contents == "") {
                    contents = "air";
                }
            }
            y = this.drawWrapped([`${formatFixed(this.probeFloats[1], 1)} C`, `pressure ${formatFixed(this.probeFloats[2], 2)}`, contents],
                y, labelHeight, 0.85);
            if (this.messageTime > 0.0) {
                Nri_ImguiDrawText(8.0, y, this.message, 1.0, 0.9, 0.4, 1.0, 0);
            }
            Nri_ImguiRender(this.sample);
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
                Nri_ReadBufferInts(queuedFrame.probeReadback, Ref(this.probe[0]), PROBE_INTS);
                Nri_ReadBufferFloats(queuedFrame.probeReadback, Ref(this.probeFloats[0]), PROBE_INTS);
            } else {
                this.probe[0] = CAPACITY;
            }
            this.readTimestamps(queuedFrame);

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
                this.recordSimulation(commandBuffer, brushMode, steps);
                const timestampReadback = queuedFrame.timestampReadback;
                if (queryPool) {
                    Nri_CmdWriteTimestamp(commandBuffer, queryPool, queryBase + 1);
                    if (timestampReadback) {
                        Nri_CmdCopyQueries(commandBuffer, queryPool, queryBase, 2, timestampReadback, 0);
                        queuedFrame.timedSteps = this.paused ? 0 : steps;
                    }
                }
                this.dispatch(commandBuffer, PROBE, 1, 0);
                const alloc = this.buffers[4];
                Nri_CmdBufferBarrier(commandBuffer, alloc, NriBufferState.Storage, NriBufferState.CopySource);
                Nri_CmdCopyBuffer(commandBuffer, queuedFrame.probeReadback, alloc, PROBE_INTS * 4);
                Nri_CmdBufferBarrier(commandBuffer, alloc, NriBufferState.CopySource, NriBufferState.Storage);
                const testReadback = this.testReadback;
                if (testReadback) {
                    if (frameIndex == this.testFrames - 1) {
                        Nri_CmdBufferBarrier(commandBuffer, this.buffers[1], NriBufferState.Storage, NriBufferState.CopySource);
                        Nri_CmdCopyBuffer(commandBuffer, testReadback, this.buffers[1], INT_SECTIONS * this.stride * 4);
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

        // -test: the U-tube's two sides hold water to the same level (its mean depth in cells over
        // each side's columns, at REST_COUNT particles a cell), and the water went under the divider.
        checkTest(): string {
            const device = this.device;
            const testReadback = this.testReadback;
            if (!device || !testReadback) {
                return "cannot read the grid back";
            }
            Nri_DeviceWaitIdle(device);
            const grid: int[] = [];
            for (let i = 0; i < INT_SECTIONS * this.stride; i++) {
                grid.push(0);
            }
            if (Nri_ReadBufferInts(testReadback, Ref(grid[0]), grid.length) == 0) {
                return "cannot read the grid back";
            }
            this.logResidual(grid);
            const divider: int = Math.floor(this.gridW / 2);
            let left = 0;
            let right = 0;
            for (let y = 1; y < this.gridH - 1; y++) {
                for (let x = 1; x < this.gridW - 1; x++) {
                    const n = grid[I_COUNT * this.stride + y * this.gridW + x];
                    if (x < divider) {
                        left += n;
                    } else if (x > divider) {
                        right += n;
                    }
                }
            }
            if (this.scene == 3) {
                const error = this.checkLavaAndIce();
                if (error != "") {
                    return error;
                }
            }
            if (this.regrid != 0) {
                const error = this.checkRegrid(grid);
                if (error != "") {
                    return error;
                }
            }
            if (this.scene == 1) {
                const leftLevel = this.surfaceLevel(grid, 4, divider - 4);
                const rightLevel = this.surfaceLevel(grid, divider + 4, this.gridW - 5);
                console.log(`U-tube: left level ${formatFixed(leftLevel, 2)} cells (${left} particles), right ${formatFixed(rightLevel, 2)} cells (${right})`);
                if (rightLevel < 10.0) {
                    return `the water didn't go under the divider: the right side's level is ${formatFixed(rightLevel, 2)} cells`;
                }
                if (Math.abs(leftLevel - rightLevel) > 1.5) {
                    return `the levels differ by ${formatFixed(Math.abs(leftLevel - rightLevel), 2)} cells, more than 1.5`;
                }
            }

            // The frame (saved with -testOutput): water drawn, blue, over about the bottom 40% of the
            // grid in the U-tube; some in the other scenes.
            const frameReadback = this.frameReadback;
            if (!frameReadback) {
                return "cannot read the frame back";
            }
            const pixels: int[] = [];
            for (let i = 0; i < this.width * this.height; i++) {
                pixels.push(0);
            }
            if (Nri_ReadBufferRGBA8(frameReadback, this.rowPitch, this.width, this.height, this.viewFormat, Ref(pixels[0]), pixels.length) == 0) {
                return "cannot read the frame back";
            }
            let blue = 0;
            for (let i = 0; i < pixels.length; i++) {
                const p = pixels[i];
                const r = p & 0xFF;
                const b = (p >> 16) & 0xFF;
                if (b > 150 && r < 80) {
                    blue++;
                }
            }
            const share = 100.0 * blue / pixels.length;
            console.log(`Water: ${formatFixed(share, 1)}% of the frame`);
            // (a turned U-tube is a narrow grid between margins)
            const minShare = this.scene == 1 && this.regrid != 2 ? 20.0 : 1.0;
            // (the overlays recolor it)
            if (this.overlay == 0 && (share < minShare || share > 50.0)) {
                return `water covers ${formatFixed(share, 1)}% of the frame, not ${formatFixed(minShare, 0)} to 50%`;
            }
            return "";
        }

        // Scene 3: the lava that fell into the water set to stone, and the ice block melted (some of
        // it, at least: the cells painted ice minus those still ice).
        checkLavaAndIce(): string {
            const cellsReadback = this.cellsReadback;
            if (!cellsReadback) {
                return "cannot read the cells back";
            }
            const cells: int[] = [];
            for (let i = 0; i < this.gridW * this.gridH; i++) {
                cells.push(0);
            }
            if (Nri_ReadBufferInts(cellsReadback, Ref(cells[0]), cells.length) == 0) {
                return "cannot read the cells back";
            }
            let stone = 0;
            let ice = 0;
            let wood = 0;
            let painted = 0;
            for (let y = 0; y < this.gridH; y++) {
                for (let x = 0; x < this.gridW; x++) {
                    const m = cells[y * this.gridW + x] & 0xFF;
                    if (m == STONE) {
                        stone++;
                    } else if (m == ICE) {
                        ice++;
                    } else if (m == WOOD) {
                        wood++;
                    }
                    // (spawn_cs paints the cells whose centers are inside the stroke)
                    const cx = (x + 0.5) / this.gridW;
                    const cy = (y + 0.5) / this.gridH;
                    if (cx >= ICE_BLOCK[0] && cx <= ICE_BLOCK[2] && cy >= ICE_BLOCK[1] && cy <= ICE_BLOCK[3]) {
                        painted++;
                    }
                }
            }
            console.log(`Lava and ice: ${stone} stone cells, ${ice} of ${painted} ice cells left, ${wood} wood cells`);
            if (stone == 0) {
                return "no lava set to stone";
            }
            if (ice >= painted) {
                return `the ice didn't melt: ${ice} ice cells, ${painted} painted`;
            }
            return "";
        }

        // -test: how far the last step's pressure is from solving its equation (pressure_cs's), over
        // the fluid cells: the largest and the mean residual, against the largest divergence.
        logResidual(grid: int[]) {
            const floatReadback = this.floatReadback;
            const cellsReadback = this.cellsReadback;
            if (!floatReadback || !cellsReadback) {
                return;
            }
            const floats: f32[] = [];
            for (let i = 0; i < FLOAT_SECTIONS * this.stride; i++) {
                floats.push(0.0);
            }
            const cells: int[] = [];
            for (let i = 0; i < this.gridW * this.gridH; i++) {
                cells.push(0);
            }
            if (Nri_ReadBufferFloats(floatReadback, Ref(floats[0]), floats.length) == 0
                || Nri_ReadBufferInts(cellsReadback, Ref(cells[0]), cells.length) == 0) {
                return;
            }
            const w = this.gridW;
            const h = this.gridH;
            const s = this.stride;
            let maxResidual = 0.0;
            let sumResidual = 0.0;
            let maxDiv = 0.0;
            let fluidCells = 0;
            for (let y = 1; y < h - 1; y++) {
                for (let x = 1; x < w - 1; x++) {
                    if (!this.fluidAt(grid, cells, x, y)) {
                        continue;
                    }
                    let diag = 0.0;
                    let sum = 0.0;
                    // (u faces' pitch w + 1, v faces' w; F_UA is section 4, F_VA 5, F_P 6, F_DIV 7)
                    const nx = [x + 1, x - 1, x, x];
                    const ny = [y, y, y + 1, y - 1];
                    const faces = [4 * s + y * (w + 1) + x + 1, 4 * s + y * (w + 1) + x, 5 * s + (y + 1) * w + x, 5 * s + y * w + x];
                    for (let k = 0; k < 4; k++) {
                        if ((cells[ny[k] * w + nx[k]] & 0xFF) >= WALL) {
                            continue;
                        }
                        const a = floats[faces[k]];
                        diag += a;
                        sum += a * floats[6 * s + ny[k] * w + nx[k]];
                    }
                    const div = floats[7 * s + y * w + x];
                    const residual = Math.abs(diag * floats[6 * s + y * w + x] - sum + div);
                    maxResidual = Math.max(maxResidual, residual);
                    sumResidual += residual;
                    maxDiv = Math.max(maxDiv, Math.abs(div));
                    fluidCells++;
                }
            }
            console.log(`Pressure residual: max ${formatFixed(maxResidual, 5)}, mean ${formatFixed(sumResidual / Math.max(fluidCells, 1), 6)} (largest divergence ${formatFixed(maxDiv, 3)}, ${fluidCells} fluid cells)`);
        }

        // A fluid cell as divergence_cs saw it: not solid, with FLIP particles in it.
        fluidAt(grid: int[], cells: int[], x: int, y: int): boolean {
            const c = y * this.gridW + x;
            if ((cells[c] & 0xFF) >= WALL) {
                return false;
            }
            let n = 0;
            // WATER, OIL, SAND (counts 0 .. 2) and LAVA (7)
            for (const k of [0, 1, 2, 7]) {
                n += grid[(I_COUNT + k) * this.stride + c];
            }
            return n > 0;
        }

        // -regrid: the grid has its wall all around and no particles in a solid cell; remade taller and
        // back, it kept every particle (the U-tube's water doesn't boil or burn); turned, it lost some
        // (the sides cropped) but not all.
        checkRegrid(grid: int[]): string {
            const cellsReadback = this.cellsReadback;
            if (!cellsReadback) {
                return "cannot read the cells back";
            }
            const cells: int[] = [];
            for (let i = 0; i < this.gridW * this.gridH; i++) {
                cells.push(0);
            }
            if (Nri_ReadBufferInts(cellsReadback, Ref(cells[0]), cells.length) == 0) {
                return "cannot read the cells back";
            }
            let inSolid = 0;
            for (let y = 0; y < this.gridH; y++) {
                for (let x = 0; x < this.gridW; x++) {
                    const m = cells[y * this.gridW + x] & 0xFF;
                    const border = x == 0 || y == 0 || x == this.gridW - 1 || y == this.gridH - 1;
                    if (border && m != WALL) {
                        return `the cell (${x}, ${y}) on the grid's edge isn't wall but ${materialName(m)}`;
                    }
                    if (m >= WALL) {
                        for (let k = 0; k < 8; k++) {
                            inSolid += grid[(I_COUNT + k) * this.stride + y * this.gridW + x];
                        }
                    }
                }
            }
            const used = CAPACITY - this.probe[0];
            console.log(`Regrid: ${this.gridW} x ${this.gridH} cells, particles ${this.regridCount} before, ${used} after, ${inSolid} in solid cells`);
            if (inSolid > 0) {
                return `${inSolid} particles in solid cells`;
            }
            if (this.regrid == 1 && used != this.regridCount) {
                return `the grid remade taller and back kept ${used} of ${this.regridCount} particles`;
            }
            if (this.regrid == 2 && (used == 0 || used >= this.regridCount)) {
                return `the turned grid kept ${used} of ${this.regridCount} particles`;
            }
            return "";
        }

        // The water's surface over columns x0 .. x1: its mean height above the floor, in cells, a
        // column's surface the top of its highest cell of at least 2 water particles.
        surfaceLevel(grid: int[], x0: int, x1: int): number {
            let sum = 0.0;
            for (let x = x0; x <= x1; x++) {
                let level = 0.0;
                for (let y = 1; y < this.gridH - 1; y++) {
                    if (grid[I_COUNT * this.stride + y * this.gridW + x] >= 2) {
                        level = this.gridH - 1 - y;
                        break;
                    }
                }
                sum += level;
            }
            return sum / (x1 - x0 + 1);
        }

        destroy() {
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

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        Nri_UseResizableWindow(sample);
        const sandbox = new PowderSandbox(sample);
        Nri_AddExampleOption(sample, "-utube");
        Nri_AddExampleOption(sample, "-roundTrip");
        Nri_AddExampleOptionWithValues(sample, "-regrid", 1);
        Nri_AddExampleOptionWithValues(sample, "-scene", 1);
        Nri_AddExampleOptionWithValues(sample, "-view", 1);
        Nri_AddExampleOptionWithValues(sample, "-substeps", 1);
        Nri_AddExampleOptionWithValues(sample, "-iterations", 1);
        Nri_AddExampleOptionWithValues(sample, "-solver", 1);
        Nri_AddExampleOptionWithValues(sample, "-vcycles", 1);
        Nri_AddExampleOptionWithValues(sample, "-smooth", 1);
        Nri_AddExampleOptionWithValues(sample, "-testFrames", 1);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-utube") {
                sandbox.scene = 1;
            } else if (arg == "-roundTrip") {
                sandbox.roundTrip = true;
            } else if (arg == "-regrid" && i + 1 < argc) {
                sandbox.regrid = Math.min(Math.max(parseInt(Nri_GetArg(argc, argv, i + 1)), 0), 2);
                i++;
            } else if (arg == "-substeps" && i + 1 < argc) {
                sandbox.substeps = Math.max(parseInt(Nri_GetArg(argc, argv, i + 1)), 1);
                i++;
            } else if (arg == "-view" && i + 1 < argc) {
                sandbox.overlay = Math.min(Math.max(parseInt(Nri_GetArg(argc, argv, i + 1)), 0), 2);
                i++;
            } else if (arg == "-scene" && i + 1 < argc) {
                sandbox.scene = parseInt(Nri_GetArg(argc, argv, i + 1));
                i++;
            } else if (arg == "-testFrames" && i + 1 < argc) {
                sandbox.testFrames = Math.max(parseInt(Nri_GetArg(argc, argv, i + 1)), 1);
                i++;
            } else if (arg == "-iterations" && i + 1 < argc) {
                sandbox.iterations = Math.max(parseInt(Nri_GetArg(argc, argv, i + 1)), 1);
                i++;
            } else if (arg == "-solver" && i + 1 < argc) {
                sandbox.solver = Nri_GetArg(argc, argv, i + 1) == "sor" ? SOLVER_SOR : SOLVER_MULTIGRID;
                i++;
            } else if (arg == "-vcycles" && i + 1 < argc) {
                sandbox.vcycles = Math.max(parseInt(Nri_GetArg(argc, argv, i + 1)), 1);
                i++;
            } else if (arg == "-smooth" && i + 1 < argc) {
                sandbox.smooth = Math.max(parseInt(Nri_GetArg(argc, argv, i + 1)), 0);
                i++;
            }
        }
        Nri_UseImgui(sample);
        return sandbox.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return PowderSandboxNri.main(argc, argv);
}

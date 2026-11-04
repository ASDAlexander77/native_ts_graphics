/// <reference path="../core/nri/nri_interop.d.ts" />
import {
    TEST_FRAMES, DEFAULT_GRID_HEIGHT, STEP_BUDGET_MS, MIN_TILE_WIDTH, DEFAULT_SUBSTEPS,
    DEFAULT_ITERATIONS, SOLVER_MULTIGRID, DEFAULT_VCYCLES, DEFAULT_SMOOTH, DEFAULT_VISCOSITY_SWEEPS,
    WATER, Tile, GRAVITY_DOWN, MESSAGE_TIME, SHAPE_CIRCLE, Level, Stroke, QueuedFrame,
    SwapChainTexture
} from "./defs";

// The sandbox's state: its GPU resources, grid, toolbar, input, level and test settings, which
// each of its parts (levels.ts, sandbox.ts, checks.ts) extends with what it does.
export class SandboxState {
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
    }

    // A message shown on the HUD for MESSAGE_TIME seconds, and logged.
    showMessage(text: string) {
        console.log(text);
        this.message = text;
        this.messageTime = MESSAGE_TIME;
    }
}

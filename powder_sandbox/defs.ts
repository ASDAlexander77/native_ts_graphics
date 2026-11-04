/// <reference path="../core/nri/nri_interop.d.ts" />

// powder_sandbox_nri's constants (the GPU sections' layout, the materials, the tools and their
// toolbar, the HUD's probe, the sounds) and the small classes the sandbox's files share.

export const WINDOW_TITLE = "NRI Example: Powder Sandbox";

// Test mode: the U-tube (water poured on one side of a glass divider short of the floor) for
// 30 seconds at 60 steps a second (the sloshing takes about that long to die down); both sides
// must end at the same level.
export const TEST_FRAMES = 1800;

// The particle slots, and the grid's shorter side in cells (its longer side follows the window's
// shape, up to MAX_GRID_LONG cells). The grid's buffers hold GRID_CAPACITY elements a section,
// enough for either orientation (a section is (gridW + 1) * (gridH + 1)), so turning a phone
// remakes the grid in the same buffers.
export const CAPACITY = 1 << 18;
export const DEFAULT_GRID_HEIGHT = 144;
// Auto quality: the GPU's step time, averaged over frames QUALITY_FRAMES[0] .. [1] after the
// start; over STEP_BUDGET_MS (3 steps a frame: 6 of a 60 Hz frame's 16.7 ms), the grid made
// smaller, its cells fewer by that ratio (MIN_GRID_HEIGHT along its shorter side at the least).
// Measured once, on the U-tube's water (an empty grid's step says little of a painted one's),
// before the session starts at the size chosen (a regrid would crop what's there). The substeps
// stay: heat and the solve are tuned per step
// (and the heat's explicit diffusion is at its stability limit).
export const QUALITY_FRAMES = [30, 90];
export const STEP_BUDGET_MS = 2.0;
export const MIN_GRID_HEIGHT = 72;
// Where the chosen height is kept (beside the save): QUALITY_MAGIC, the height.
export const QUALITY_PATH = "powder_sandbox.quality";
export const QUALITY_MAGIC = 0x51445750;
export const QUALITY_HEADER_INTS = 2;
export const MAX_GRID_LONG = 432;
export const GRID_CAPACITY = (DEFAULT_GRID_HEIGHT + 1) * (MAX_GRID_LONG + 1);
// A toolbar tile's narrowest (its label in ImGui's default font fits).
export const MIN_TILE_WIDTH = 72.0;
// How far (in pixels) a press on the toolbar moves before it scrolls it instead of tapping a tile.
export const DRAG_THRESHOLD = 8.0;
// Zoom: a wheel notch's factor (a pinch on Android sends a notch per 48 dp its fingers spread),
// and the closest (cells this many times larger than when the grid fits the window).
export const ZOOM_STEP = 1.15;
export const MAX_ZOOM = 8.0;
// A second finger down this soon (in seconds) after the first takes back what the first painted:
// it was a pinch, not a stroke.
export const STROKE_CANCEL_TIME = 0.3;
// A press held this long (in seconds) on the grid without moving (DRAG_THRESHOLD) opens the
// brushes' menu around it: the shapes in a ring, up, right, down and left; what it painted is
// taken back.
export const LONG_PRESS_TIME = 0.45;
// -profile: every PROFILE_EVERY frames, a timestamp after each of the simulation's dispatches (at
// most PROFILE_QUERIES); every PROFILE_REPORT such frames, each entry's mean milliseconds a frame,
// the costliest first.
export const PROFILE_EVERY = 30;
export const PROFILE_QUERIES = 1024;
export const PROFILE_REPORT = 8;
// The brush's radius (in cells): its smallest and largest.
export const MIN_BRUSH = 0.5;
export const MAX_BRUSH = 30.0;
// GLFW's middle button (Android's two-finger gesture holds it down, its cursor between the fingers).
export const MOUSE_MIDDLE = 2;
export const GROUP_SIZE = 256;
// SandboxConstants: 32 floats or uints.
export const CONSTANTS_FLOATS = 32;
export const CONSTANTS_SIZE = CONSTANTS_FLOATS * 4;
// powder_sandbox.hlsl's particle types (1 .. PARTICLE_TYPES, a count section each), gridInt and
// gridFloat sections, and u_Alloc's free list's start.
// (probe_cs packs the counts three to an int, 10 bits each, from u_Alloc[4], under the wind at
// u_Alloc[10]: up to 18 types)
export const PARTICLE_TYPES = 20;
// The glow's sections past INT_SECTIONS (powder_sandbox.hlsl's I_GLOW, GLOW_SECTIONS, GLOW_SCALE).
export const I_GLOW = 6 + PARTICLE_TYPES + 10;
// (red, green, blue and the hole field, a pass)
export const GLOW_SECTIONS = 8;
export const GLOW_SCALE = 4096.0;
// The sparks' state after the glow's (I_SPARK, SPARK_SECTIONS), spark_cs's iterations a frame.
export const I_SPARK = I_GLOW + GLOW_SECTIONS;
export const SPARK_SECTIONS = 2;
export const SPARK_ITERATIONS = 2;
// The int buffer: the step's sections, then those.
export const ALL_INT_SECTIONS = 6 + PARTICLE_TYPES + 10 + GLOW_SECTIONS + SPARK_SECTIONS;
export const INT_SECTIONS = 6 + PARTICLE_TYPES + 10;
// The step's events for sound (I_EVENTS: splash, fizz, fire, boom), read back after the probe's
// ints.
export const I_EVENTS = 6 + PARTICLE_TYPES + 8;
export const EVENT_COUNT = 4;
export const EVENT_NAMES = ["splash", "fizz", "fire", "boom"];
// Nri_PlaySound's sounds for them, the fewest events a sound needs, the time before it plays again
// (seconds), and its loudness at EVENTS_LOUD events.
export const EVENT_MIN = [8, 1, 30, 3];
export const EVENT_COOLDOWN = [0.12, 0.25, 0.07, 0.6];
export const EVENTS_LOUD = [400, 60, 3000, 300];
// The water's salinity summed (I_SALT; SALT_SCALE a particle at 1).
export const I_SALT = 6 + PARTICLE_TYPES + 3;
export const SALT_SCALE = 256.0;
export const FLOAT_SECTIONS = 13;
// The rigid bodies' records in F_BODY (powder_sandbox.hlsl's MAX_BODIES of BODY_FLOATS).
export const F_BODY = 12;
export const MAX_BODIES = 16;
export const BODY_FLOATS = 10;
export const ALLOC_LIST = 16;
export const I_COUNT = 6;
// The float sections a regrid carries over (the rest the next step remakes): F_TPRE .. F_LIFE,
// the cell temperatures and life.
export const F_TPRE = 8;
export const CARRIED_FLOAT_SECTIONS = 4;
// struct Particle: 8 floats.
export const PARTICLE_SIZE = 32;
// The HUD's readout: u_Alloc's first 16 ints (free slots, then probe_cs's).
export const PROBE_INTS = 16;
// Its int that's 1 while there are viscous particles (A_VISCOUS).
export const PROBE_VISCOUS = 14;
// And the air's fastest face (a float, A_WIND).
export const PROBE_WIND = 13;
// The wind at the probe's cell (x, then y: floats).
export const PROBE_AIR = 10;
// A level's goal's count (A_GOAL).
export const PROBE_GOAL = 12;
// The most particles -regrid 2 may lose turning a grid on its side: the top it crops should hold
// only air, but a drop thrown up there can cling under the ceiling for many seconds (its cell's
// velocity is sampled toward the ceiling's zero face, so it lets go slowly).
export const CLINGING_DROPS = 16;

// Cells per second squared, down.
export const GRAVITY = 300.0;
export const FLIP_RATIO = 0.95;
export const SOR_OMEGA = 1.6;
export const DEFAULT_SUBSTEPS = 3;
export const DEFAULT_ITERATIONS = 40;
// The pressure solvers: SOR (-iterations red-black sweeps over the grid), or multigrid
// (-vcycles V-cycles, -smooth sweeps on each level going down and again coming up; its
// smoothing isn't over-relaxed). Its coarsest level is the first of at most MG_COARSE_CELLS cells
// (powder_sandbox.hlsl's).
export const SOLVER_SOR = 0;
export const SOLVER_MULTIGRID = 1;
export const DEFAULT_VCYCLES = 1;
export const DEFAULT_SMOOTH = 2;
// viscosity_cs's red-black sweep pairs a step (-viscosity N; 0 leaves honey and lava as runny as
// water).
export const DEFAULT_VISCOSITY_SWEEPS = 4;
export const MG_COARSE_CELLS = 256;

// Materials and tools (powder_sandbox.hlsl's numbers).
export const WATER = 1;
export const OIL = 2;
export const SAND = 3;
export const FIRE = 4;
export const SMOKE = 5;
export const EMBER = 14;
export const STEAM = 6;
export const LAVA = 8;
export const ACID = 9;
export const SALT = 10;
export const GUNPOWDER = 11;
export const HONEY = 12;
export const PETROL = 13;
export const WALL = 16;
export const GLASS = 17;
export const WOOD = 18;
export const URANIUM = 19;
export const EMITTER = 20;
export const ICE = 21;
export const STONE = 22;
export const METAL = 23;
export const FAN = 24;
export const BLOCK = 25;
export const BATTERY = 26;
export const LAMP = 27;
export const ERASE = 32;
export const HEAT = 33;
export const COOL = 34;
export const SALT_WATER = 36;
export const SPARK = 38;
export const C4 = 28;
export const COAL = 29;
export const FUSE = 30;
// Particle types past the tools' ids (powder_sandbox.hlsl's; their count sections after EMBER's).
export const HYDROGEN = 40;
export const OXYGEN = 41;
export const NEON = 42;
export const THERMITE = 43;
export const NITRO = 44;
export const SEED = 45;
// Solids past the particle types' ids (powder_sandbox.hlsl's).
export const CLONE = 48;
export const BLACK_HOLE = 49;
export const WHITE_HOLE = 50;
export const SPONGE = 51;
export const PLANT = 52;
export const SWITCH = 53;
export const DETECTOR = 54;
export const HEATER = 55;
// Not the shader's: a tool that paints nothing, its cursor the cell under the pointer (touch has
// no hover to read a cell with).
export const INSPECT = 35;

// The compute entries, in this order.
export const INIT_GRID = 0;
export const INIT_PARTICLES = 1;
export const CLEAR = 2;
export const P2G = 3;
export const GRID = 4;
export const HEAT_SOURCE = 5;
export const HEAT_DIFFUSE = 6;
export const DIVERGENCE = 7;
export const PRESSURE = 8;
export const PROJECT = 9;
export const G2P = 10;
export const SPAWN = 11;
export const PROBE = 12;
export const REGRID_GRID = 13;
export const REGRID_PARTICLES = 14;
export const MG_SETUP = 15;
export const MG_SMOOTH = 16;
export const MG_RESTRICT = 17;
export const MG_PROLONG = 18;
export const MG_COARSE = 19;
export const VISCOSITY = 20;
export const AIR = 21;
export const BODIES = 22;
export const GOAL = 23;
export const GLOW_EMIT = 24;
export const GLOW_X = 25;
export const GLOW_Y = 26;
export const SPARKS = 27;
// The floats at u_Multigrid's start that hold the air's faces (powder_sandbox.hlsl's AIR_FLOATS).
export const AIR_FLOATS = 3040;
export const ENTRIES = ["init_grid_cs", "init_particles_cs", "clear_cs", "p2g_cs", "grid_cs", "heat_source_cs", "heat_diffuse_cs",
    "divergence_cs", "pressure_cs", "project_cs", "g2p_cs", "spawn_cs", "probe_cs", "regrid_grid_cs",
    "regrid_particles_cs", "mg_setup_cs", "mg_smooth_cs", "mg_restrict_cs", "mg_prolong_cs", "mg_coarse_cs", "viscosity_cs", "air_cs", "bodies_cs", "goal_cs",
    "glow_emit_cs", "glow_x_cs", "glow_y_cs", "spark_cs"];

// The buffers' barrier bits.
export const B_PARTICLES = 1;
export const B_GRID_INT = 2;
export const B_GRID_FLOAT = 4;
export const B_CELLS = 8;
export const B_ALLOC = 16;
export const B_MG = 32;
export const B_ALL = 63;
export const BUFFERS = 6;

// The toolbar: a row of groups' tabs over a row of the chosen group's tiles (a tool or an action
// each).
export class Tile {
    public group: int = 0;
    constructor(public label: string, public tool: int, public r: number, public g: number, public b: number) {
    }
}
export const ACTION_SMALLER = 100;
export const ACTION_LARGER = 101;
export const ACTION_PAUSE = 102;
export const ACTION_VIEW = 103;
export const ACTION_CLEAR = 104;
export const ACTION_SHAPE = 105;
export const ACTION_UNDO = 106;
export const ACTION_SAVE = 107;
export const ACTION_LOAD = 108;
export const ACTION_LEVEL = 109;
// The Gravity tile cycles the gravity: down, off, toward a point (GRAVITY_PLACE then the tool,
// a tap on the grid moving the point), or the phone's down (its gravity sensor's, across the
// screen; held while it lies flat, under TILT_FLAT g across it; down with no sensor, or -tilt
// x y's direction).
export const ACTION_GRAVITY = 110;
export const GRAVITY_DOWN = 0;
export const GRAVITY_OFF = 1;
export const GRAVITY_POINT = 2;
export const GRAVITY_TILT = 3;
export const GRAVITY_NAMES = ["down", "off", "point", "tilt"];
export const GRAVITY_LABELS = ["Gravity", "No gravity", "Attract", "Tilt"];
export const TILT_FLAT = 0.15;
export const STANDARD_GRAVITY = 9.81;
export const GRAVITY_PLACE = 37;
// Levels: their files (LEVEL_DIRECTORY<name>.json), the ones the Levels tile goes through listed
// in LEVEL_DIRECTORY/index.json ({ "levels": [names] }). A level: { "name": "...", "goal":
// { "text": "...", "material": "water", "box": [x0, y0, x1, y1], "count": N, "lit": true (lit
// cells only: a lamp's), "atMost": true (N at most, not at least), "hold": S (for S seconds) },
// "stars": [T3, T2] (3 stars for the goal reached within T3 seconds, 2 within T2, else 1),
// "strokes": [{ "tool": "glass", "box": [x0, y0, x1, y1], "emit": "sand" (an emitter's), "blow":
// "right" (a fan's), "repeat": N (strokes painted N frames) }, ...], "solution": [strokes] (one
// way to reach the goal, for its tests) }, boxes in fractions of the grid.
export const LEVEL_DIRECTORY = "media/powder_sandbox/scenes/";
export const BLOW_NAMES = ["right", "down", "left", "up"];
// A goal's material's flag for lit cells only (powder_sandbox.hlsl's).
export const GOAL_LIT = 0x100;
// The best stars of index.json's levels, kept beside the save: STARS_MAGIC, how many, then each
// one's (in index.json's order).
export const STARS_PATH = "powder_sandbox.stars";
export const STARS_MAGIC = 0x53524154;

// The simulation's state, for undo and saves: the particles, the grid's float sections (the
// temperatures, the pressure the next step starts from, burning and melting), the cells, the free
// list (this.buffers' indices), one after another. The int sections are counts every step
// remakes.
export const STATE_BUFFERS = [0, 2, 3, 4];
// Snapshots taken as strokes begin (and before Clear, Load and a regrid), newest restored first.
export const UNDO_DEPTH = 4;
// The save file (in the executable's directory; the app's data directory on Android): a header
// (SAVE_MAGIC, SAVE_VERSION, the grid's width and height, the particle slots), then the state.
// Version 2: the grid's buffers at GRID_CAPACITY (version 1's were the grid's own size).
export const SAVE_PATH = "powder_sandbox.save";
export const SAVE_MAGIC = 0x53445750;
// (3: the bodies' float section; 4: the gravity in the header (its mode, its point in 1/256
// cells), version 3's still read, its gravity down)
export const SAVE_VERSION = 4;
export const SAVE_HEADER_INTS = 8;
export const SAVE_HEADER_INTS_3 = 5;
// How long a message (saved, loaded, nothing to undo) shows, in seconds.
export const MESSAGE_TIME = 2.5;
// GLFW's key codes.
export const KEY_Z = 90;
export const KEY_LEFT_CONTROL = 341;
export const KEY_RIGHT_CONTROL = 345;
export const VIEW_NAMES = ["Materials", "Pressure", "Temperature"];
// Scene 3's ice block, in grid fractions (x0, y0, x1, y1).
export const ICE_BLOCK = [0.12, 0.5, 0.2, 0.72];
// Scene 4: the bars (x0, the metal's y0, x1, their height, the stone's y0), heated at their left
// ends for HEAT_STROKES frames and measured at BAR_PROBE across; the acid's tub (x0, the top of
// its walls, x1, the top of the wood in it).
export const BARS = [0.05, 0.3, 0.3, 0.03, 0.42];
export const HEAT_STROKES = 500;
// (metal spreads the heat along the bar: its heated end is cooler than stone's, its far side
// hotter)
export const BAR_PROBE = 0.17;
export const ACID_TUB = [0.4, 0.55, 0.6, 0.8];
// The salt's tank (x0, the top of its walls, x1, the water's surface), and the salt poured over it
// (how far above the water, how thick: thin, or it lands as a slab that splashes water out).
export const SALT_TANK = [0.68, 0.25, 0.95, 0.6];
export const SALT_POUR = [0.2, 0.04];
// Scene 5: the gunpowder pile (x0, y0, x1), on the floor under a layer of sand (SAND_LAYER thick),
// against a glass wall (at x1, up to GUNPOWDER_WALL) with a pool of water behind it (POOL: its
// right wall's x, its surface). (Its own scene: in scene 4 its fire set the acid's wood alight and boiled the
// salt water.)
export const GUNPOWDER_PILE = [0.4, 0.86, 0.52];
export const SAND_LAYER = 0.06;
export const GUNPOWDER_WALL = 0.5;
export const POOL = [0.8, 0.7];
// Scene 6: a block of water and one of honey (x0 .. x1 across from their side's left, from y0 to
// the floor), either side of a glass divider at HONEY_DIVIDER, let go at once. (Small, on a wide
// floor: spread out, water's a film, not a slab as deep as honey's mound.)
export const DAM = [0.05, 0.13, 0.85];
export const HONEY_DIVIDER = 0.5;
// Scene 7: a film of water a cell thick (x0, y0, x1, to the floor) on the open floor: surface
// tension pulls it into beads, covering at most BEAD_SHARE of its columns.
export const BEAD = [0.3, 0.985, 0.7];
export const BEAD_SHARE = 0.6;
// Scene 8: a fan line (x, y0 down to the floor) blowing right across a stream of sand falling from
// an emitter (x, y) inside its jet; the sand must land WIND_DRIFT of the grid's width right of the
// emitter on average. (The fan's air comes back over it: sand falling through that too, or smoke
// rising into it, goes both ways.)
export const WIND_FAN = [0.06, 0.3, 1.0];
export const WIND_SAND = [0.3, 0.4];
export const WIND_DRIFT = 0.05;
// Scene 9: a pool (glass walls at x0 and x1 from y, water from WATER_Y) with a block dropped in
// (FLOATER: x0, y0, x1, y1), and a ledge (x0, y, x1) with a tall block standing half over its
// edge (TIPPER: x0, y0, x1, its bottom at the ledge).
export const BODY_POOL = [0.05, 0.5, 0.5, 0.62];
export const FLOATER = [0.2, 0.3, 0.32, 0.38];
export const LEDGE = [0.65, 0.7, 0.8];
export const TIPPER = [0.78, 0.45, 0.82];
// Scenes 10 and 11: glass tubs (TUBS: each one's x0, x1; their walls from TUB_TOP, their liquid
// from TUB_LIQUID to the floor). Scene 10: acid poured (from ACID_POUR[0] to [1]) over water in
// the first and into the empty second: the water dilutes it (warmed), the glass holds the other.
// Scene 11: oil in the first, petrol in the second, both lit at their surface (FIRE_BAND, from
// its top to its bottom), and oil sealed in the third (a glass lid at TUB_TOP) that can't burn:
// the petrol burns away, the oil burns down slowly.
export const TUBS = [0.05, 0.3, 0.375, 0.625, 0.7, 0.95];
export const TUB_TOP = 0.6;
export const TUB_LIQUID = 0.8;
export const ACID_POUR = [0.62, 0.72];
export const FIRE_BAND = [0.77, 0.83];
// Scene 12: a wood fire (GAS_WOOD: x0, y0, x1, to the floor) under a glass ceiling (GAS_CEILING:
// x0, y, x1): its plume drives the air up through the probe above it (GAS_PROBE), at
// PLUME_WIND cells a second at the least, and its smoke spreads under the ceiling, over
// SMOKE_SPREAD of the grid's width (both nothing like that without the air's lift, or the
// gases' spreading).
export const GAS_WOOD = [0.45, 0.88, 0.55];
export const GAS_CEILING = [0.1, 0.5, 0.9];
export const GAS_PROBE = [0.5, 0.65];
export const PLUME_WIND = 10.0;
export const SMOKE_SPREAD = 0.25;
// (and the fire glows: red light GLOW_BESIDE cells beside the wood, over GLOW_NEAR, under GLOW_FAR
// at the grid's side; it throws embers)
export const GLOW_BESIDE = 6;
export const GLOW_NEAR = 0.05;
export const GLOW_FAR = 0.005;
// Scene 13: a block of water and one of sand in mid-air (BLOBS: each one's x0, y0, x1, y1).
// With -gravity off they stay (their centers within BLOB_DRIFT cells); toward the point (the
// grid's center), they gather round it (their mean distance from it under GATHERED of where
// they started).
export const BLOBS = [0.3, 0.3, 0.45, 0.55, 0.55, 0.3, 0.7, 0.55];
export const BLOB_DRIFT = 3.0;
export const GATHERED = 0.75;
// Tilted (-tilt), they fall that way: their centers TILT_FALL cells at least along it, and over
// twice as far as across it.
export const TILT_FALL = 15.0;
// Scene 14: circuits (CIRCUITS: each one's battery x, lamp x, y; a tub (x0, x1) in the wire, or
// none at -1), a battery, a metal wire, a lamp: bare, through salt water, through fresh water.
// The first two lamps shine, the third doesn't. Gunpowder dropped on a live wire (SPARK_POWDER:
// x0, y0, x1, y1; the wire's battery, its end, its y in SPARK_WIRE) goes off, a pile on a wall
// ledge (CONTROL_POWDER, its ledge's y) doesn't: under POWDER_LEFT of its gunpowder is left.
export const CIRCUITS = [0.05, 0.45, 0.2, -1.0, -1.0, 0.05, 0.6, 0.62, 0.2, 0.4, 0.05, 0.6, 0.85, 0.2, 0.4];
export const WIRE = 0.03;
export const SPARK_WIRE = [0.55, 0.85, 0.2];
export const SPARK_POWDER = [0.68, 0.12, 0.78, 0.19];
export const CONTROL_POWDER = [0.07, 0.38, 0.17, 0.44, 0.45];
export const POWDER_LEFT = 0.2;
// Scene 15: tubs of salt water (ELECTRO_TUBS: each one's x0, x1; ELECTRO_Y: their top, floor; the
// wire in at ELECTRO_WIRE), the first's wire from a battery, the second's from a wall: the first
// splits into hydrogen (HYDROGEN_MADE at least) and oxygen (OXYGEN_MADE), the second makes under
// GAS_LEAK of it. Glass tubes of neon (NEON_TUBES: x0, x1, then each one's y0, y1), the first
// wired from a battery: it shines, the second doesn't.
export const ELECTRO_TUBS = [0.06, 0.26, 0.74, 0.94];
export const ELECTRO_Y = [0.5, 0.75];
export const ELECTRO_WIRE = 0.62;
export const HYDROGEN_MADE = 40;
export const OXYGEN_MADE = 15;
export const GAS_LEAK = 0.2;
export const NEON_TUBES = [0.38, 0.62, 0.18, 0.25, 0.32, 0.39];
// Scene 16: glass boxes of hydrogen (H2_BOXES: each one's x0, x1; H2_Y: their y0, y1), the first
// lit at its bottom: it burns (under HYDROGEN_LEFT of the second's hydrogen left), into steam.
// Fuses (FUSES: x0, x1, then each one's y), the first lit at its left end: it burns along at
// FUSE_SPEED cells a second (between its two values), the second doesn't. Scene 20: blocks of coal
// and wood (BURN_BLOCKS: coal x0, x1, wood x0, x1; from BURN_TOP to the floor), lit on top: the
// wood burns away (under WOOD_LEFT left), the coal burns slowly (over COAL_LEFT left, some of it
// alight).
export const H2_BOXES = [0.05, 0.3, 0.7, 0.95];
export const H2_Y = [0.08, 0.36];
export const HYDROGEN_LEFT = 0.3;
export const FUSES = [0.1, 0.9, 0.5, 0.6];
export const FUSE_SPEED = [8.0, 40.0];
export const BURN_BLOCKS = [0.3, 0.4, 0.6, 0.7];
export const BURN_TOP = 0.8;
export const WOOD_LEFT = 0.6;
export const COAL_LEFT = 0.9;
// Scene 17: thermite on metal plates (PLATES: each one's x0, x1; PLATE_Y: its y0, y1; the
// thermite from THERMITE_TOP, a little narrower), the first lit: it burns a hole (its plate under
// PLATE_LEFT of the second's metal).
export const PLATES = [0.08, 0.32, 0.68, 0.92];
export const PLATE_Y = [0.55, 0.58];
export const THERMITE_TOP = 0.49;
export const PLATE_LEFT = 0.9;
// Scene 18: nitroglycerin dropped into a glass tub (NITRO_TUBS: each one's x0, x1, from NITRO_TOP
// to the floor; NITRO_DROP: x0, y0, x1, y1), and some painted at rest in another: the dropped goes
// off (under NITRO_LEFT of the other's left). Scene 19: C-4 (C4_BLOCKS: each one's x0, x1; C4_Y:
// y0, y1), the first wired from a battery: it goes off (under C4_LEFT of the second's cells left).
export const NITRO_TUBS = [0.08, 0.32, 0.68, 0.92];
export const NITRO_TOP = 0.82;
export const NITRO_DROP = [0.15, 0.08, 0.25, 0.16];
export const NITRO_LEFT = 0.2;
export const C4_BLOCKS = [0.2, 0.3, 0.7, 0.8];
export const C4_Y = [0.37, 0.46];
export const C4_LEFT = 0.1;
// Scene 21: water dropped on a clone (CLONED: its x0, x1, y0, y1; the drop CLONE_DROP above, as
// x0, x1, y0, y1 relative to it) and the same on a wall block CLONE_TWIN over to the right, each
// in a glass tub (CLONE_TUBS: x0, x1 each, from CLONE_TUB_TOP): the clone's ends with over
// CLONE_MORE times the wall's water.
export const CLONED = [0.1, 0.2, 0.6, 0.64];
export const CLONE_DROP = [0.02, -0.02, -0.2, -0.12];
export const CLONE_TWIN = 0.6;
export const CLONE_MORE = 2.5;
export const CLONE_TUBS = [0.03, 0.4, 0.6, 0.97];
export const CLONE_TUB_TOP = 0.3;
// Scene 22: sand dropped toward a black hole, a white hole and a wall block (HOLE_XS: each one's
// x0; HOLE_Y: their y0, y1; HOLE_W wide; the sand HOLE_SAND, y0, y1, over each, wider): the black
// hole's side keeps under SWALLOWED of the wall's sand; under REPELLED of the sand resting on
// the wall (the HOLE_TOUCH just above it) rests on the white hole.
export const HOLE_XS = [0.18, 0.48, 0.78];
export const HOLE_Y = [0.55, 0.6];
export const HOLE_W = 0.04;
export const HOLE_SAND = [0.25, 0.35];
export const HOLE_TOUCH = 0.05;
export const SWALLOWED = 0.3;
export const REPELLED = 0.2;
// Scene 23: a sponge dipped in a tub of water (SPONGE_BOX: x0, x1, y0, y1), a wall block in its
// twin over to the right (SPONGE_TWIN), the tubs SPONGE_TUBS (x0, x1 each) from SPONGE_TUB_TOP,
// their water from SPONGE_WATER: the sponge's keeps under SOAKED of the other's water. Seeds
// dropped into a pool (SEED_POOL: x0, x1, its walls' top, its water's; SEED_WET: the seeds' x0,
// x1, y0, y1) grow over PLANT_CELLS plant cells, some above the water (PLANT_ABOVE); seeds on a
// dry ledge (SEED_LEDGE: x0, x1, its y; the seeds just above) don't.
export const SPONGE_BOX = [0.12, 0.23, 0.65, 0.97];
export const SPONGE_TWIN = 0.65;
export const SPONGE_TUBS = [0.05, 0.3, 0.7, 0.95];
export const SPONGE_TUB_TOP = 0.7;
export const SPONGE_WATER = 0.8;
export const SOAKED = 0.6;
export const SEED_POOL = [0.4, 0.6, 0.85, 0.93];
export const SEED_WET = [0.45, 0.55, 0.75, 0.8];
export const SEED_LEDGE = [0.42, 0.58, 0.45];
export const PLANT_CELLS = 30;
export const PLANT_ABOVE = 5;
// Scene 24: circuits (SWITCH_ROWS: each one's y; a battery at x 0.05, a wire, a switch at
// SWITCH_X, a wire, a lamp at LAMP_X), the first switch toggled on by a Spark stroke: its lamp
// shines, the second's doesn't. Detectors (DETECTOR_ROWS) wired to lamps, sand dropped on the
// first: its lamp shines, the second's doesn't. A heater (HEATERS: x0, x1, then each one's y0,
// y1) wired to a battery warms over HEATED, the other stays under COLD.
export const SWITCH_ROWS = [0.15, 0.3];
export const SWITCH_X = 0.3;
export const LAMP_X = 0.45;
export const DETECTOR_ROWS = [0.5, 0.7];
export const HEATERS = [0.75, 0.85, 0.28, 0.36, 0.68, 0.76];
export const HEATED = 150.0;
export const COLD = 60.0;
// The brush's shapes: circle and square paint along the pointer's path; line and box paint, on
// release, the line (brush-wide) or the rectangle from where the press began.
export const SHAPE_CIRCLE = 0;
export const SHAPE_SQUARE = 1;
export const SHAPE_LINE = 2;
export const SHAPE_BOX = 3;
export const SHAPE_NAMES = ["Circle", "Square", "Line", "Box"];

// A multigrid level's width or height (level 0's is the grid's), each half the last's (rounded up).
export function levelSize(size: int, level: int): int {
    let s = size;
    for (let l = 0; l < level; l++) {
        s = Math.floor((s + 1) / 2);
    }
    return s;
}

// The levels a gridW x gridH grid's multigrid has: down to the first of at most MG_COARSE_CELLS.
export function levelCount(gridW: int, gridH: int): int {
    let levels = 1;
    while (levelSize(gridW, levels - 1) * levelSize(gridH, levels - 1) > MG_COARSE_CELLS) {
        levels++;
    }
    return levels;
}

// The floats u_Multigrid's levels 1 and up take (powder_sandbox.hlsl's mgLevel).
export function multigridFloats(gridW: int, gridH: int): int {
    let floats = 0;
    const levels = levelCount(gridW, gridH);
    for (let l = 1; l < levels; l++) {
        const w = levelSize(gridW, l);
        const h = levelSize(gridH, l);
        floats += 3 * w * h + (w + 1) * h + w * (h + 1);
    }
    return floats;
}

// A fan's direction from the pointer's move (dx, dy, in cells): its larger axis, up for under a
// cell.
export function fanDirectionOf(dx: number, dy: number): int {
    if (Math.abs(dx) < 1.0 && Math.abs(dy) < 1.0) {
        return 3;
    }
    if (Math.abs(dx) >= Math.abs(dy)) {
        return dx > 0.0 ? 0 : 2;
    }
    return dy > 0.0 ? 1 : 3;
}

// A particle type's count section in gridInt (powder_sandbox.hlsl's countSection), and the type
// of a count section's index past I_COUNT.
export function countSection(material: int): int {
    return I_COUNT + (material >= HYDROGEN ? material - HYDROGEN + EMBER : material - 1);
}

export function sectionMaterial(k: int): int {
    return k < EMBER ? k + 1 : k - EMBER + HYDROGEN;
}

export function materialName(material: int): string {
    if (material == 1) { return "water"; }
    if (material == 2) { return "oil"; }
    if (material == 3) { return "sand"; }
    if (material == 4) { return "fire"; }
    if (material == 5) { return "smoke"; }
    if (material == 6) { return "steam"; }
    if (material == 7) { return "neutron"; }
    if (material == 8) { return "lava"; }
    if (material == 9) { return "acid"; }
    if (material == 10) { return "salt"; }
    if (material == 11) { return "gunpowder"; }
    if (material == 12) { return "honey"; }
    if (material == 13) { return "petrol"; }
    if (material == 14) { return "ember"; }
    if (material == 16) { return "wall"; }
    if (material == 17) { return "glass"; }
    if (material == 18) { return "wood"; }
    if (material == 19) { return "uranium"; }
    if (material == 20) { return "emitter"; }
    if (material == 21) { return "ice"; }
    if (material == 22) { return "stone"; }
    if (material == 23) { return "metal"; }
    if (material == 24) { return "fan"; }
    if (material == 25) { return "block"; }
    if (material == 26) { return "battery"; }
    if (material == 27) { return "lamp"; }
    if (material == 28) { return "c-4"; }
    if (material == 29) { return "coal"; }
    if (material == 30) { return "fuse"; }
    if (material == 40) { return "hydrogen"; }
    if (material == 41) { return "oxygen"; }
    if (material == 42) { return "neon"; }
    if (material == 43) { return "thermite"; }
    if (material == 44) { return "nitroglycerin"; }
    if (material == 45) { return "seed"; }
    if (material == 48) { return "clone"; }
    if (material == 49) { return "black hole"; }
    if (material == 50) { return "white hole"; }
    if (material == 51) { return "sponge"; }
    if (material == 52) { return "plant"; }
    if (material == 53) { return "switch"; }
    if (material == 54) { return "detector"; }
    if (material == 55) { return "heater"; }
    return "air";
}

// A tool or material by its name in a level's file (materialName's, or the tools'), or -1.
export function toolNamed(name: string): int {
    // ("air" is materialName's answer for the ids that name nothing)
    for (let m = 1; m < 64; m++) {
        if (materialName(m) == name && name != "air") {
            return m;
        }
    }
    if (name == "erase") { return ERASE; }
    if (name == "heat") { return HEAT; }
    if (name == "cool") { return COOL; }
    if (name == "salt water") { return SALT_WATER; }
    if (name == "spark") { return SPARK; }
    return -1;
}

// A level read from its file: its strokes (in fractions of the grid) and its goal (goalCount
// particles of goalMaterial, or cells of a solid one, in goalBox; none if goalCount is 0; at most
// goalCount with goalAtMost, for goalHold seconds), the times of its stars, its solution.
export class LevelStroke {
    constructor(public tool: int, public box: number[], public emit: int) {
    }
}

export class Level {
    name: string = "";
    goalText: string = "";
    goalMaterial: int = 0;
    goalBox: number[] = [];
    goalCount: int = 0;
    goalLit: boolean = false;
    goalAtMost: boolean = false;
    goalHold: number = 0.0;
    stars: number[] = [];
    strokes: LevelStroke[] = [];
    solution: LevelStroke[] = [];
}

// n stars, as the HUD shows them.
export function starText(n: int): string {
    let text = "";
    for (let k = 0; k < n; k++) {
        text = `${text}*`;
    }
    return text;
}

// A rectangle a scene paints with a tool (in cells); emit: an emitter's material.
export class Stroke {
    constructor(public tool: int, public x0: number, public y0: number, public x1: number, public y1: number, public emit: int) {
    }
}

// What a frame in flight keeps besides its command buffer (NriFrameRing's): where it reads the HUD's
// probe back, and the GPU's timestamps around its simulation (and how many steps it took), read
// when its turn comes again.
export class QueuedFrame {
    public timedSteps: int = -1;
    // The steps it simulated (whether or not timed), for its events.
    public steps: int = 0;
    // The level's time after it (-1 before the level's strokes were painted), for its goal.
    public levelTime: number = -1.0;
    constructor(public probeReadback: NriBufferHandle, public timestampReadback: NriBufferHandle | null) {
    }
}

// A swap chain texture, its view and the semaphores of its acquire and release.
export class SwapChainTexture {
    constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
        public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
    }
}

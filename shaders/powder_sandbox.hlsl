// powder_sandbox_nri: a falling-sand sandbox with real fluid physics. Liquids and powders are FLIP
// particles on a staggered (MAC) grid with a variable-density pressure projection, so water is
// incompressible: it levels out in connected vessels, sloshes and keeps its momentum. Oil (lighter)
// floats, sand (heavier) sinks and piles. Fire, smoke and steam are free particles that rise; neutrons
// fly straight from uranium. Every particle and cell carries a temperature that diffuses through the
// grid and drives boiling, condensation, ignition and burning.
//
// The grid is gridW x gridH cells, a cell one unit, y down (gravity +y). Every grid array is a
// section of `stride` = (gridW + 1) * (gridH + 1) elements of one of three buffers, so a cell, a
// u face (at x = i, y = j + 0.5) or a v face (at x = i + 0.5, y = j) all fit in a section.

#include <donut/shaders/binding_helpers.hlsli>

struct SandboxConstants
{
    uint gridW;
    uint gridH;
    uint stride;
    uint capacity;

    float dt;
    float gravity;
    uint frame;
    uint substep;

    // The brush: tool, mode (0 none, 1 brushRadius around the segment from (x0, y0) to (x1, y1), round
    // or square (brushShape), 2 the rectangle between them), in cells. The regrid entries, which
    // don't paint, read tool and brushMode as the old grid's width and height, and emitType and
    // parity as the offset (in cells, signed) of the old grid's corner in the new one.
    uint tool;
    uint brushMode;
    float brushX0;
    float brushY0;

    float brushX1;
    float brushY1;
    float brushRadius;
    // What new emitters emit.
    uint emitType;

    // pressure_cs: the cells it updates ((x + y) & 1).
    uint parity;
    float flip;
    // display_ps: 0 materials, 1 pressure, 2 temperature.
    uint overlay;
    float time;

    // display_ps: the grid's top left corner on screen and a cell's size, in pixels.
    float viewX;
    float viewY;
    float cellPixels;
    // init_grid_cs: 0 an empty box, 1 the U-tube (a glass divider short of the floor).
    uint scene;

    float omega;
    // probe_cs: the cell read back for the HUD; display_ps: the pointer, where the cursor ends.
    float probeX;
    float probeY;
    // Bits 0..3: the brush's shape in mode 1 (0 round, 1 square). Bits 4..7: display_ps's cursor, the
    // outline of the area a brush in that mode (0 none) would paint from (cursorX0, cursorY0) to the
    // pointer; 3 the cell under the pointer, inspected. Bits 8..9: the gravity (GRAVITY_DOWN, _OFF,
    // _POINT: toward (gravityX, gravityY)), gravity strong.
    uint brushShape;

    float cursorX0;
    float cursorY0;
    float gravityX;
    float gravityY;
};
DECLARE_PUSH_CONSTANTS(SandboxConstants, g_C, 0, 0);

// Materials. Particles: 1..7; cells: 16 and up (solid).
#define EMPTY 0
#define WATER 1
#define OIL 2
#define SAND 3
#define FIRE 4
#define SMOKE 5
#define STEAM 6
#define NEUTRON 7
#define LAVA 8
#define ACID 9
#define SALT 10
#define GUNPOWDER 11
#define HONEY 12
#define PETROL 13
// A spark off fire or lava: carried up by the air, falling, cooling; it only shows (and glows).
#define EMBER 14
// Particle types past the cells' and the tools' ids (their count sections after EMBER's, see
// countSection): hydrogen and oxygen (from water a current runs through: hydrogen burns into steam,
// oxygen flares), neon (it conducts, glowing), thermite (a powder burning into molten metal),
// nitroglycerin (a liquid going off at a shock, at a spark or a flame, or hot).
#define HYDROGEN 40
#define OXYGEN 41
#define NEON 42
#define THERMITE 43
#define NITRO 44
// A seed: a powder sprouting into a plant where it's wet.
#define SEED 45
// The particle types' count sections: 1 .. EMBER, then HYDROGEN .. SEED.
#define PARTICLE_TYPES 20
#define WALL 16
#define GLASS 17
#define WOOD 18
#define URANIUM 19
#define EMITTER 20
#define ICE 21
#define STONE 22
#define METAL 23
// A solid that blows the air (its direction in bits 8 and 9: 0 right, 1 down, 2 left, 3 up).
#define FAN 24
// A rigid body's cell (its body in bits 8..11; bodies_cs draws them).
#define BLOCK 25
// Electricity (spark_cs): a battery sparks the conductors beside it; a lamp, a conductor, shines
// after a spark.
#define BATTERY 26
#define LAMP 27
// C-4 goes off (into gunpowder going off) hot, at a flame or a spark; coal burns slowly; a fuse
// burns along itself at a steady speed.
#define C4 28
#define COAL 29
#define FUSE 30
// Tools that aren't materials.
#define ERASE 32
#define HEAT 33
#define COOL 34
// Paints water as salty as it gets (WATER particles, salinity 1).
#define SALT_WATER 36
// Sparks the conductors under the brush.
#define SPARK 38
// Solids past the particle types' ids (isSolidMaterial: all from WALL on, the tools painting
// nothing). A clone emits the first particle type to touch it (learned into bits 8..15); a black
// hole pulls everything in (the hole field, see I_GLOW) and swallows what touches it, a white hole
// pushes it away; a sponge soaks up water (held in bits 8..15) and lets it out hot; a plant drinks
// water (its energy in bits 8..15) to grow, against the gravity; a switch conducts when on (bit 8:
// the Spark tool's touch toggles it, bit 9 holding while it's touched); a detector sparks the
// conductors beside it while a particle's beside it; a heater, a conductor, warms while powered.
#define CLONE 48
#define BLACK_HOLE 49
#define WHITE_HOLE 50
#define SPONGE 51
#define PLANT 52
#define SWITCH 53
#define DETECTOR 54
#define HEATER 55
#define FIRST_SOLID_AFTER_TOOLS CLONE
#define SWITCH_ON 0x100
#define SWITCH_TOUCHED 0x200

// A cell: material in bits 0-7, an emitter's material in 8-15, BURNING (wood); MELTED: the ice or
// stone (bits 8-15) that was here melted this step (spawn_cs turns it into water or lava).
#define BURNING 0x10000
#define MELTED 0x20000

// Lava's temperature when painted or emitted; it turns to stone below SOLIDIFY_LAVA, stone melts
// above MELT_STONE. Melting ice and stone takes in their latent heat (in degrees of the cell's own
// temperature: water's latent heat is about 80 times its specific heat) before they turn liquid.
#define LAVA_TEMP 1200.0
#define SOLIDIFY_LAVA 700.0
#define MELT_STONE 1000.0
#define FREEZE_WATER -0.5
#define ICE_TEMP -30.0
#define LATENT_ICE 80.0
#define LATENT_STONE 200.0
// How often (per second) an acid particle next to a solid eats it, through the face it tries; and
// in water, dilutes into it (becoming water), DILUTE_HEAT warmer: much acid in little water boils.
#define ACID_RATE 2.0
#define DILUTE_RATE 0.5
#define DILUTE_HEAT 80.0
// Salt water: a WATER particle's life is its salinity (0 fresh .. 1 as salty as it gets), which
// makes it up to SALT_DENSITY denser. Salt in water dissolves at DISSOLVE_RATE a second (into a
// particle of salinity 1) while its cell's water is under SATURATED; the water in a cell evens its
// salinity out at SALT_MIX a second.
#define SALT_SCALE 256.0
#define SALT_DENSITY 0.25
#define DISSOLVE_RATE 1.0
#define SATURATED 0.9
#define SALT_MIX 0.3
// Gunpowder goes off at IGNITE_GUNPOWDER: its grain becomes hot fire flung outward, and its gas
// pushes what's around it away, as BLAST_VOLUME cells of volume a grain (a divergence the pressure
// solve carries to the liquids and powders around).
#define IGNITE_GUNPOWDER 250.0
#define BLAST_VOLUME 1.5
#define BLAST_TEMP 1500.0
#define BLAST_SPEED 150.0
// Oil and petrol burn where they're open to the air, from fire in their cell or beside it, or from
// heat. Oil slowly: a particle there turns to fire CATCH_OIL times a second (living OIL_BURN seconds
// and more), so a burning slick lasts. Petrol catches CATCH_PETROL times a second (heated to
// IGNITE_PETROL), so its heat lights it through, then burns hot and short with a whoosh: a grain in
// PETROL_WHOOSH blasts, as gunpowder's do.
#define IGNITE_OIL 250.0
#define CATCH_OIL 1.0
#define OIL_BURN 3.0
#define IGNITE_PETROL 200.0
#define CATCH_PETROL 40.0
#define PETROL_BURN 0.4
#define PETROL_FIRE_TEMP 1200.0
#define PETROL_WHOOSH 8
// Viscosity, in cells^2 a second (its velocity diffusing that fast): honey's, and lava's from cold
// (where it sets) to LAVA_TEMP. Water, oil and acid have none.
#define HONEY_VISCOSITY 10000.0
#define LAVA_VISCOSITY_COLD 200.0
#define LAVA_VISCOSITY_HOT 40.0
// Surface tension, for thin liquid only (drops, streams, films): a liquid particle is pulled toward
// where its 3 x 3 cells hold more liquid (each cell's count capped at REST_COUNT), at up to
// SURFACE_TENSION cells a second squared, fading out as its 5 x 5 cells fill up to TENSION_FULL cells'
// worth. A body of liquid, its surface too (two full rows under it), is past that: there it would
// only fight the pressure solve.
#define SURFACE_TENSION 4000.0
#define TENSION_FULL 12.0
// Air (air_cs): its coarse cells' size, the most cells and faces it has (432 x 144 cells: 54 x 18),
// where its faces' velocities are in u_Multigrid, and how it moves: fans' push (cells a second
// squared, for a fan line across a coarse cell), damping (a second), top speed, the pressure's
// sweeps. Gases relax toward it as they slowed toward rest (GAS_DRAG a step); airborne grains (under
// REST_COUNT in their cell) at POWDER_DRAG a second.
#define AIR_CELL 8
#define AIR_THREADS 256
#define AIR_MAX_CELLS 972
#define AIR_MAX_FACES 1026
#define AIR_PER_THREAD 5
#define AIR_U 0
#define AIR_V 1032
// (the pressure, kept for the next step's solve to start from)
#define AIR_P 2064
#define AIR_FLOATS 3040
#define FAN_ACCEL 6000.0
#define AIR_DAMPING 1.0
#define WIND_MAX 200.0
#define AIR_ITERATIONS 20
#define AIR_OMEGA 1.7
#define GAS_DRAG 0.03
#define POWDER_DRAG 3.0
// Gases: lighter than the air around them by how much hotter ((T - AMBIENT) over T, absolute), and
// steam by STEAM_LIGHTNESS more (its molar mass 18 to air's 29), so they rise against gravity that
// much; cooling toward AMBIENT at GAS_COOLING a second (fire stays hot while it burns), slowing as
// they cool; pushed apart where they're crowded (GAS_SPREAD a particle of difference between
// neighbors, cells a second squared), so they fill a room or spread under a ceiling; wandering
// (GAS_JITTER). The air takes their lift too (AIR_LIFT of it, over a coarse cell of GAS_FULL a
// cell): plumes, the air drawn in under a fire and turning over at the top.
#define STEAM_LIGHTNESS 0.38
#define GAS_COOLING 0.4
#define GAS_SPREAD 60.0
#define AIR_LIFT 1.0
#define GAS_FULL 2.0
// How long smoke lingers (seconds, up to twice as long): long enough to fill a room.
#define SMOKE_LIFE 6.0
// Embers: thrown off a fire particle EMBER_RATE times a second, off lava's surface LAVA_EMBER_RATE
// times a second a cell; living EMBER_LIFE seconds (half to one and a half times), at EMBER_TEMP,
// cooling at EMBER_COOLING a second, falling at EMBER_WEIGHT of the gravity, dragged toward the air
// at EMBER_DRAG a second.
#define EMBER_RATE 0.4
#define LAVA_EMBER_RATE 0.15
#define EMBER_LIFE 1.2
#define EMBER_TEMP 900.0
#define EMBER_COOLING 1.0
#define EMBER_WEIGHT 0.25
#define EMBER_DRAG 4.0
// Group A's chemistry. Gases' lightness over the air's (by molar mass: hydrogen 2, neon 20, oxygen
// 32 to the air's 29). A current into water (a sparked metal cell beside it: the electrode) splits a
// particle ELECTROLYSIS_RATE a step, two in three into hydrogen. Hydrogen and oxygen beside fire, or
// at IGNITE_GAS, catch CATCH_GAS times a second: hydrogen burns (at HYDROGEN_FIRE_TEMP, a
// whoosh from one in HYDROGEN_WHOOSH) into steam, oxygen flares (at OXYGEN_FIRE_TEMP).
#define HYDROGEN_LIGHTNESS 0.93
#define NEON_LIGHTNESS 0.31
#define OXYGEN_LIGHTNESS -0.1
#define ELECTROLYSIS_RATE 0.03
#define IGNITE_GAS 500.0
#define CATCH_GAS 40.0
#define HYDROGEN_FIRE_TEMP 1500.0
#define HYDROGEN_WHOOSH 4
#define OXYGEN_FIRE_TEMP 1300.0
// Thermite beside fire, in lava's cell, or at IGNITE_THERMITE catches CATCH_THERMITE times a second,
// into lava at THERMITE_TEMP (molten iron; it sets into stone). Metal melts at MELT_METAL, taking
// LATENT_METAL degrees.
#define IGNITE_THERMITE 1000.0
#define CATCH_THERMITE 30.0
#define THERMITE_TEMP 3500.0
// (molten thermite keeps burning, at THERMITE_TEMP, THERMITE_BURN seconds: half to one and a half
// times; its lava's life)
#define THERMITE_BURN 3.0
#define MELT_METAL 1500.0
#define LATENT_METAL 150.0
// Molten iron (lava hotter than THERMITE_CUT: thermite's) cuts through the metal it touches (the
// cell opened), CUT_RATE times a second (through the side it tries), giving up CUT_HEAT degrees.
#define THERMITE_CUT 1550.0
#define CUT_RATE 8.0
#define CUT_HEAT 150.0
// Nitroglycerin goes off as gunpowder does (NITRO_BLAST times its blast) at IGNITE_NITRO, heated
// there by a flame, a spark, or a shock (its velocity changed by over NITRO_SHOCK cells a second in
// a step: a fall, a blast).
#define IGNITE_NITRO 200.0
#define NITRO_SHOCK 150.0
#define NITRO_BLAST 2
// C-4 goes off at IGNITE_C4 (or a flame or a spark beside it): its cell into C4_GRAINS grains of
// gunpowder going off. Coal catches at IGNITE_COAL (a flame: CATCH_COAL times a second), burning
// COAL_BURN seconds (up to half again). A fuse catches at IGNITE_FUSE, a flame or a spark, or from
// a fuse beside it burning FUSE_PASS seconds (so it burns along at 1 / FUSE_PASS cells a second),
// burning FUSE_BURN seconds.
#define IGNITE_C4 400.0
#define C4_GRAINS 6
#define IGNITE_COAL 500.0
#define CATCH_COAL 0.5
#define COAL_BURN 25.0
#define IGNITE_FUSE 700.0
#define FUSE_PASS 0.05
#define FUSE_BURN 0.3
// Group B. The holes' pull: HOLE_PULL times the hole field's gradient (a cell's worth of hole, as
// blurred, a cell), at most HOLE_MAX gravities. A sponge's cell holds SPONGE_HOLD particles of water,
// soaking up a touching one SOAK_RATE times a second, letting one out a step over SPONGE_SQUEEZE. A
// seed in water's cell or beside it sprouts SPROUT_RATE times a second (the plant starting with
// SEED_ENERGY); a plant drinks a touching water particle DRINK_RATE times a second (an energy
// each), growing a cell (up, or 45 degrees either side) GROW_RATE times a second while it has
// energy, the new cell taking the rest; it burns as wood does, faster (PLANT_BURN seconds). A
// heater powered warms at HEATER_RATE degrees a second, up to HEATER_MAX.
#define HOLE_PULL 400000.0
#define HOLE_MAX 4.0
#define SPONGE_HOLD 8
#define SOAK_RATE 40.0
#define SPONGE_SQUEEZE 60.0
#define SPROUT_RATE 1.0
#define SEED_ENERGY 6
#define DRINK_RATE 2.0
#define GROW_RATE 4.0
#define PLANT_BURN 1.0
#define HEATER_RATE 300.0
#define HEATER_MAX 600.0

// gridInt sections: the P2G sums (fixed point), the particle counts per material, the temperature sums,
// the fissions.
#define I_USUM 0
#define I_UW 1
#define I_UM 2
#define I_VSUM 3
#define I_VW 4
#define I_VM 5
#define I_COUNT 6 // + material - 1, for the particle types (WATER .. PARTICLE_TYPES)
#define I_TSUM (I_COUNT + PARTICLE_TYPES)
#define I_TCOUNT (I_TSUM + 1)
#define I_FISSION (I_TSUM + 2)
// The cell's water's salinity, summed (SALT_SCALE a particle at 1).
#define I_SALT (I_TSUM + 3)
// The cell's gunpowder going off this step.
#define I_BLAST (I_TSUM + 4)
// The faces' viscosity sums (weight * viscosity, the viscous particles' only; unscaled, as the
// WEIGHT_SCALE of I_UM would overflow at honey's).
#define I_UVISC (I_TSUM + 5)
#define I_VVISC (I_TSUM + 6)
// The cell's liquid particles (the FLIP ones but the powders), for surface tension.
#define I_LIQUID (I_TSUM + 7)
// The step's events for sound, in its first EVENT_COUNT elements (g2p_cs's; read back with the
// probe): liquid hitting something (its velocity changed by over SPLASH_SPEED in a step), acid eating
// a cell or water boiling, fire burning, gunpowder going off.
#define I_EVENTS (I_TSUM + 8)
#define INT_SECTIONS (I_TSUM + 9)
// Past those (not cleared each step), the glow: the cells' light (fixed point, GLOW_SCALE at 1, red,
// green and blue sections), blurred along x into I_GLOW_X, then along y back into I_GLOW, once a
// frame (glow_emit_cs, glow_x_cs, glow_y_cs). A Gaussian of GLOW_SIGMA cells, out to GLOW_RADIUS;
// shown GLOW_STRENGTH times over.
// A fourth section a pass, I_HOLE, blurs the same way the holes (a black hole's cell GLOW_SCALE, a
// white hole's minus that): the hole field, whose gradient pulls (holePull).
#define I_GLOW INT_SECTIONS
#define I_HOLE (INT_SECTIONS + 3)
#define I_GLOW_X (INT_SECTIONS + 4)
#define GLOW_SECTIONS 8
#define GLOW_SCALE 4096.0
#define GLOW_SIGMA 7.0
#define GLOW_RADIUS 18
#define GLOW_STRENGTH 3.0
// Past the glow's, the sparks' state, in two sections spark_cs's iterations take turns reading and
// writing (an even number a frame: the state's in I_SPARK between frames). A conductor's: in bits
// 0..7 its phase, 0 idle, SPARK_LIVE sparked (its neighbors spark at the next iteration), then
// resting SPARK_REST iterations (so a pulse runs one way, not back); a lamp's light in bits 8..15,
// LAMP_HOLD iterations from its last spark. A battery is live every BATTERY_PERIOD iterations.
// Conductors: metal, lamps, salt water (cells with a water particle or more, SALT_CONDUCTS salty), neon.
#define I_SPARK (INT_SECTIONS + GLOW_SECTIONS)
#define SPARK_SECTIONS 2
#define SPARK_ITERATIONS 2
#define SPARK_LIVE 1
#define SPARK_REST 4
#define BATTERY_PERIOD 12
#define LAMP_HOLD 30
#define SALT_CONDUCTS 0.25
// Lit neon's color (its glow's too).
#define NEON_COLOR float3(1.0, 0.32, 0.22)
#define EVENT_SPLASH 0
#define EVENT_FIZZ 1
#define EVENT_FIRE 2
#define EVENT_BOOM 3
#define EVENT_COUNT 4
#define SPLASH_SPEED 50.0

// gridFloat sections.
#define F_U 0
#define F_V 1
#define F_UOLD 2
#define F_VOLD 3
// 1 / density of the faces' fluid
#define F_UA 4
#define F_VA 5
// pressure * dt (pressure_cs), 0 outside the fluid
#define F_P 6
#define F_DIV 7
// a cell's temperature: its particles' mean before heat_source_cs, after it, and after diffusion
#define F_TPRE 8
#define F_TSRC 9
#define F_TCELL 10
// a burning cell's remaining seconds; melting ice's or stone's latent heat taken in so far
#define F_LIFE 11
// the rigid bodies' records (MAX_BODIES of BODY_FLOATS)
#define F_BODY 12
#define MAX_BODIES 16
#define BODY_FLOATS 10
#define B_ACTIVE 0
#define B_X 1
#define B_Y 2
#define B_ANGLE 3
#define B_VX 4
#define B_VY 5
#define B_SPIN 6
#define B_HALFW 7
#define B_HALFH 8
#define B_DENSITY 9
// Blocks: their density (they float), how they bounce and slide, their drag in liquid (a second, all
// wet), bodies_cs's workgroup.
#define BLOCK_DENSITY 0.6
#define BODY_RESTITUTION 0.1
#define BODY_FRICTION 0.6
#define BODY_WATER_DRAG 3.0
#define BODY_THREADS 256

// u_Alloc: the free particle slots' count, the HUD's probe, then the free slots.
#define A_FREE 0
#define A_PROBE 1
// 1 while a frame's steps have viscous particles (p2g_cs sets it, clear_cs clears it at the frame's
// first step); read back with the probe, so the CPU skips viscosity_cs without them.
#define A_VISCOUS 14
// The air's fastest face this step (air_cs's; a float), for the tests' log.
#define A_WIND 13
// A level's goal's count (goal_cs's).
#define A_GOAL 12
#define A_LIST 16

#define VEL_SCALE 4096.0
#define WEIGHT_SCALE 4096.0
#define TEMP_SCALE 16.0
#define REST_COUNT 4.0
#define AMBIENT 20.0

struct Particle
{
    float2 pos;
    float2 vel;
    float temp;
    uint type;
    float life;
    // a neutron's birth cell (no fission there until it leaves), else unused
    uint origin;
};

uint hash(uint v)
{
    // PCG
    uint state = v * 747796405u + 2891336453u;
    uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

float random01(uint seed)
{
    return float(hash(seed) >> 8) * (1.0 / 16777216.0);
}

float2 randomDirection(uint seed)
{
    const float a = 6.2831853 * random01(seed);
    return float2(cos(a), sin(a));
}

bool isSolidMaterial(uint m)
{
    return m >= WALL;
}

bool isFlipMaterial(uint m)
{
    return (m >= WATER && m <= SAND) || m == LAVA || (m >= ACID && m <= PETROL) || m == THERMITE || m == NITRO || m == SEED;
}

// Powders pile (static friction) instead of flowing level.
bool isPowder(uint m)
{
    return m == SAND || m == SALT || m == GUNPOWDER || m == THERMITE || m == SEED;
}

bool isGasMaterial(uint m)
{
    return (m >= FIRE && m <= STEAM) || (m >= HYDROGEN && m <= NEON);
}

// A particle type's count section (gridInt's I_COUNT on).
uint countSection(uint m)
{
    return I_COUNT + (m >= HYDROGEN ? m - HYDROGEN + EMBER : m - 1);
}

float density(uint m)
{
    return m == OIL ? 0.8 : (m == SAND ? 2.0 : (m == LAVA ? 2.6 : (m == ACID ? 1.3 : (m == SALT ? 2.2 : (m == GUNPOWDER ? 1.7 : (m == HONEY ? 1.4 : (m == PETROL ? 0.7 : (m == THERMITE ? 2.3 : (m == NITRO ? 1.6 : (m == SEED ? 1.1 : 1.0))))))))));
}

// A particle's density: its material's, salt water's by its salinity.
float particleDensity(Particle p)
{
    return p.type == WATER ? 1.0 + SALT_DENSITY * p.life : density(p.type);
}

uint cellIndex(int x, int y)
{
    return uint(y) * g_C.gridW + uint(x);
}

uint uIndex(int i, int j)
{
    return uint(j) * (g_C.gridW + 1) + uint(i);
}

uint vIndex(int i, int j)
{
    return uint(j) * g_C.gridW + uint(i);
}

bool inGrid(int x, int y)
{
    return x >= 0 && y >= 0 && x < int(g_C.gridW) && y < int(g_C.gridH);
}

// The largest of p's distances along x and y to the segment a..b at its nearest point: the minimum
// of a convex piecewise linear function of t, so at one of its corners (or an end).
float chebyshevToSegment(float2 p, float2 a, float2 b)
{
    const float2 d = p - a;
    const float2 u = b - a;
    const float candidates[5] = {
        1.0,
        abs(u.x) > 1e-6 ? d.x / u.x : 0.0,
        abs(u.y) > 1e-6 ? d.y / u.y : 0.0,
        abs(u.x - u.y) > 1e-6 ? (d.x - d.y) / (u.x - u.y) : 0.0,
        abs(u.x + u.y) > 1e-6 ? (d.x + d.y) / (u.x + u.y) : 0.0,
    };
    float best = max(abs(d.x), abs(d.y));
    for (uint i = 0; i < 5; i++)
    {
        const float2 q = abs(d - saturate(candidates[i]) * u);
        best = min(best, max(q.x, q.y));
    }
    return best;
}

// How far p is outside a brush (mode 1: radius around the segment a..b, round or square; mode 2:
// the rectangle between a and b), in cells: <= 0 inside.
float brushDistance(float2 p, uint mode, uint shape, float2 a, float2 b, float radius)
{
    if (mode == 2)
    {
        const float2 q = abs(p - (a + b) * 0.5) - abs(b - a) * 0.5;
        return max(q.x, q.y);
    }
    if (shape == 1)
    {
        return chebyshevToSegment(p, a, b) - radius;
    }
    const float2 ab = b - a;
    const float t = saturate(dot(p - a, ab) / max(dot(ab, ab), 1e-6));
    return length(p - (a + t * ab)) - radius;
}

bool insideBrush(float2 p)
{
    return brushDistance(p, g_C.brushMode, g_C.brushShape & 0xF, float2(g_C.brushX0, g_C.brushY0),
        float2(g_C.brushX1, g_C.brushY1), g_C.brushRadius) <= 0.0;
}

float3 heatColor(float t)
{
    // Incandescence above about 450 degrees, white hot at 1500.
    const float x = saturate((t - 450.0) / 1050.0);
    return float3(saturate(x * 3.0), saturate(x * 3.0 - 1.0), saturate(x * 3.0 - 2.0)) * smoothstep(0.0, 0.15, x);
}

// --- Simulation (compute) ------------------------------------------------------------------

// Gravity (brushShape's bits 8..9): down, off, or toward the point (gravityX, gravityY), as strong
// everywhere (a planet's), easing off within GRAVITY_CORE cells of it.
#define GRAVITY_DOWN 0
#define GRAVITY_OFF 1
#define GRAVITY_POINT 2
// (as strong, toward the unit direction (gravityX, gravityY): the phone's tilt)
#define GRAVITY_TILT 3
#define GRAVITY_CORE 2.0

uint gravityMode()
{
    return (g_C.brushShape >> 8) & 3u;
}

#ifdef SIMULATION

RWStructuredBuffer<Particle> u_Particles : register(u0);

// Whole particles read and written member by member: DXC makes `u_Particles[i] = p` (and the read)
// an OpCopyLogical, which Adreno's compiler (Adreno 740, Android 16) fails to compile.
Particle loadParticle(uint index)
{
    Particle p;
    p.pos = u_Particles[index].pos;
    p.vel = u_Particles[index].vel;
    p.temp = u_Particles[index].temp;
    p.type = u_Particles[index].type;
    p.life = u_Particles[index].life;
    p.origin = u_Particles[index].origin;
    return p;
}

void storeParticle(uint index, Particle p)
{
    u_Particles[index].pos = p.pos;
    u_Particles[index].vel = p.vel;
    u_Particles[index].temp = p.temp;
    u_Particles[index].type = p.type;
    u_Particles[index].life = p.life;
    u_Particles[index].origin = p.origin;
}
RWStructuredBuffer<int> u_GridInt : register(u1);
RWStructuredBuffer<float> u_GridFloat : register(u2);
RWStructuredBuffer<uint> u_Cells : register(u3);
RWStructuredBuffer<int> u_Alloc : register(u4);
// The air's faces (AIR_FLOATS), then the multigrid's levels from 1.
RWStructuredBuffer<float> u_Multigrid : register(u5);

uint gi(uint section, uint index)
{
    return section * g_C.stride + index;
}

uint cellMaterial(int x, int y)
{
    if (!inGrid(x, y))
    {
        return WALL;
    }
    return u_Cells[cellIndex(x, y)] & 0xFF;
}

bool solidCell(int x, int y)
{
    return isSolidMaterial(cellMaterial(x, y));
}

bool solidAt(float2 p)
{
    return solidCell(int(floor(p.x)), int(floor(p.y)));
}

int countOf(uint material, int x, int y)
{
    if (!inGrid(x, y))
    {
        return 0;
    }
    return u_GridInt[gi(countSection(material), cellIndex(x, y))];
}

int flipCount(int x, int y)
{
    return countOf(WATER, x, y) + countOf(OIL, x, y) + countOf(SAND, x, y) + countOf(LAVA, x, y) + countOf(ACID, x, y)
        + countOf(SALT, x, y) + countOf(GUNPOWDER, x, y) + countOf(HONEY, x, y) + countOf(PETROL, x, y)
        + countOf(THERMITE, x, y) + countOf(NITRO, x, y) + countOf(SEED, x, y);
}

// A cell's side o's neighbor, as an offset: 0 left, 1 right, 2 up, 3 down. (Worked out, not a local
// const int2[4]: Adreno's compiler got such an array indexed in a loop wrong, the bodies' pressure
// forces NaN.)
int2 sideOffset(int o)
{
    return o < 2 ? int2(o * 2 - 1, 0) : int2(0, o * 2 - 5);
}

bool fluidCell(int x, int y)
{
    return inGrid(x, y) && !solidCell(x, y) && flipCount(x, y) > 0;
}

float2 gravityOnly(float2 pos)
{
    const uint mode = gravityMode();
    if (mode == GRAVITY_OFF)
    {
        return float2(0.0, 0.0);
    }
    if (mode == GRAVITY_POINT)
    {
        const float2 d = float2(g_C.gravityX, g_C.gravityY) - pos;
        const float len = length(d);
        return len > 1e-3 ? d / len * g_C.gravity * saturate(len / GRAVITY_CORE) : float2(0.0, 0.0);
    }
    if (mode == GRAVITY_TILT)
    {
        return float2(g_C.gravityX, g_C.gravityY) * g_C.gravity;
    }
    return float2(0.0, g_C.gravity);
}

// The holes' pull at pos: up the hole field's gradient (toward black holes, away from white ones).
float2 holePull(float2 pos)
{
    const int x = clamp(int(floor(pos.x)), 1, int(g_C.gridW) - 2);
    const int y = clamp(int(floor(pos.y)), 1, int(g_C.gridH) - 2);
    const float2 gradient = 0.5 * float2(float(u_GridInt[gi(I_HOLE, cellIndex(x + 1, y))] - u_GridInt[gi(I_HOLE, cellIndex(x - 1, y))]),
        float(u_GridInt[gi(I_HOLE, cellIndex(x, y + 1))] - u_GridInt[gi(I_HOLE, cellIndex(x, y - 1))])) / GLOW_SCALE;
    const float2 pull = HOLE_PULL * gradient;
    const float most = HOLE_MAX * g_C.gravity;
    return dot(pull, pull) > most * most ? normalize(pull) * most : pull;
}

// The gravity (its mode's) and the holes' pull.
float2 gravityAt(float2 pos)
{
    return gravityOnly(pos) + holePull(pos);
}

// Down at pos, as the neighbor (of the eight) the gravity points nearest; false with none (a powder
// there isn't resting on anything).
bool gravityDown(float2 pos, out int2 down)
{
    const float2 g = gravityAt(pos);
    down = int2(0, 1);
    if (dot(g, g) < 1e-6)
    {
        return false;
    }
    // (within 22.5 degrees of an axis: that one)
    const float2 n = normalize(g);
    down = int2(abs(n.x) > 0.3827 ? (n.x > 0.0 ? 1 : -1) : 0, abs(n.y) > 0.3827 ? (n.y > 0.0 ? 1 : -1) : 0);
    return true;
}

// A neighbor's offset turned 45 degrees, one way (+1) or the other.
int2 turned45(int2 d, int way)
{
    return way > 0 ? int2(sign(d.x - d.y), sign(d.x + d.y)) : int2(sign(d.x + d.y), sign(d.y - d.x));
}

// A gas's lift, as a fraction of gravity: its heat over the air's, steam lighter still.
float gasLift(uint type, float temp)
{
    return max(temp - AMBIENT, 0.0) / (max(temp, AMBIENT) + 273.15) + (type == STEAM ? STEAM_LIGHTNESS
        : (type == HYDROGEN ? HYDROGEN_LIGHTNESS : (type == NEON ? NEON_LIGHTNESS : (type == OXYGEN ? OXYGEN_LIGHTNESS : 0.0))));
}

int gasCount(int x, int y)
{
    return countOf(FIRE, x, y) + countOf(SMOKE, x, y) + countOf(STEAM, x, y) + countOf(HYDROGEN, x, y)
        + countOf(OXYGEN, x, y) + countOf(NEON, x, y);
}

// A side open to the air (in the grid, not solid, no liquid or powder in it): where oil can burn.
bool airBeside(int x, int y)
{
    for (int o = 0; o < 4; o++)
    {
        const int2 n = int2(x, y) + sideOffset(o);
        if (inGrid(n.x, n.y) && !solidCell(n.x, n.y) && flipCount(n.x, n.y) == 0)
        {
            return true;
        }
    }
    return false;
}

// Fire in the cell or a side's.
bool fireBeside(int x, int y)
{
    if (countOf(FIRE, x, y) > 0)
    {
        return true;
    }
    for (int o = 0; o < 4; o++)
    {
        const int2 n = int2(x, y) + sideOffset(o);
        if (inGrid(n.x, n.y) && countOf(FIRE, n.x, n.y) > 0)
        {
            return true;
        }
    }
    return false;
}

float cellSalinity(uint c, int x, int y)
{
    const int water = countOf(WATER, x, y);
    return water > 0 ? float(u_GridInt[gi(I_SALT, c)]) / SALT_SCALE / float(water) : 0.0;
}

// Electricity's conductors: metal, lamps, salt water, neon.
bool conducts(int x, int y)
{
    const uint m = cellMaterial(x, y);
    return m == METAL || m == LAMP || m == HEATER || (m == SWITCH && (u_Cells[cellIndex(x, y)] & SWITCH_ON) != 0)
        || (m == EMPTY && (countOf(NEON, x, y) >= 1
        || (countOf(WATER, x, y) >= 1 && cellSalinity(cellIndex(x, y), x, y) >= SALT_CONDUCTS)));
}

// The cell's spark phase (between frames: I_SPARK's).
int sparkPhase(int x, int y)
{
    return inGrid(x, y) ? u_GridInt[gi(I_SPARK, cellIndex(x, y))] & 0xFF : 0;
}

// A spark in the cell or beside it, sparked at either of the frame's iterations (so that every cell
// of a pulse's path is seen).
bool sparkBeside(int x, int y)
{
    for (int o = 0; o < 5; o++)
    {
        const int2 s = int2(x, y) + (o < 4 ? sideOffset(o) : int2(0, 0));
        const int phase = sparkPhase(s.x, s.y);
        if (phase >= SPARK_LIVE && phase <= SPARK_LIVE + 1)
        {
            return true;
        }
    }
    return false;
}

// A sparked metal cell beside it (either of the frame's iterations): an electrode, for electrolysis.
bool electrodeBeside(int x, int y)
{
    for (int o = 0; o < 4; o++)
    {
        const int2 s = int2(x, y) + sideOffset(o);
        const int phase = sparkPhase(s.x, s.y);
        if (phase >= SPARK_LIVE && phase <= SPARK_LIVE + 1 && cellMaterial(s.x, s.y) == METAL)
        {
            return true;
        }
    }
    return false;
}

float gf(uint section, uint index)
{
    return u_GridFloat[gi(section, index)];
}

// A slot from the free list, or -1 when it's empty (or fewer than `reserve` are left: gases and
// neutrons don't take the last ones, so the liquids can still be painted).
int allocateParticle(int reserve)
{
    int count;
    InterlockedAdd(u_Alloc[A_FREE], -1, count);
    if (count <= reserve)
    {
        InterlockedAdd(u_Alloc[A_FREE], 1);
        return -1;
    }
    return u_Alloc[A_LIST + count - 1];
}

void freeParticle(uint index)
{
    int count;
    InterlockedAdd(u_Alloc[A_FREE], 1, count);
    u_Alloc[A_LIST + count] = int(index);
}

void spawn(uint type, float2 pos, float2 vel, float temp, float life, uint origin, int reserve)
{
    const int index = allocateParticle(reserve);
    if (index < 0)
    {
        return;
    }
    Particle p;
    p.pos = pos;
    p.vel = vel;
    p.temp = temp;
    p.type = type;
    p.life = life;
    p.origin = origin;
    storeParticle(index, p);
}

uint seedOf(uint index, uint salt)
{
    return hash(index * 9781u + g_C.frame * 6271u + g_C.substep * 1013u + salt * 7919u);
}

// --- Setup ---

// The cells (a wall around the grid; the scene), the grid at rest and the ambient temperature.
[numthreads(256, 1, 1)]
void init_grid_cs(uint3 id : SV_DispatchThreadID)
{
    const uint t = id.x;
    if (t < AIR_FLOATS)
    {
        u_Multigrid[t] = 0.0;
    }
    if (t >= g_C.stride)
    {
        return;
    }
    for (uint s = 0; s < F_TPRE; s++)
    {
        u_GridFloat[gi(s, t)] = 0.0;
    }
    for (uint g = 0; g < GLOW_SECTIONS; g++)
    {
        u_GridInt[gi(I_GLOW + g, t)] = 0;
    }
    u_GridInt[gi(I_SPARK, t)] = 0;
    u_GridInt[gi(I_SPARK + 1, t)] = 0;
    u_GridFloat[gi(F_TPRE, t)] = AMBIENT;
    u_GridFloat[gi(F_TSRC, t)] = AMBIENT;
    u_GridFloat[gi(F_TCELL, t)] = AMBIENT;
    u_GridFloat[gi(F_LIFE, t)] = 0.0;
    // (no bodies)
    u_GridFloat[gi(F_BODY, t)] = 0.0;
    if (t >= g_C.gridW * g_C.gridH)
    {
        return;
    }
    const int x = int(t % g_C.gridW);
    const int y = int(t / g_C.gridW);
    const int w = int(g_C.gridW);
    const int h = int(g_C.gridH);
    uint m = EMPTY;
    if (x == 0 || y == 0 || x == w - 1 || y == h - 1)
    {
        m = WALL;
    }
    else if (g_C.scene == 1 && x == w / 2 && y < h - 1 - h / 8)
    {
        m = GLASS;
    }
    u_Cells[t] = m;
}

// Every particle slot free.
[numthreads(256, 1, 1)]
void init_particles_cs(uint3 id : SV_DispatchThreadID)
{
    const uint t = id.x;
    if (t >= g_C.capacity)
    {
        return;
    }
    Particle p = (Particle)0;
    storeParticle(t, p);
    u_Alloc[A_LIST + t] = int(g_C.capacity - 1 - t);
    if (t == 0)
    {
        u_Alloc[A_FREE] = int(g_C.capacity);
    }
}

// --- Regrid (the grid made again in another shape, a phone turned) ---
//
// The old grid's cells and its cell temperatures and life (F_TPRE .. F_LIFE) were copied into
// u_GridInt (which every step remakes): the cells at 0, section F_TPRE + k at (1 + k) * old stride.
// What the old grid held inside its walls lands at the offset (dx, dy); what falls outside the new
// grid's walls is lost.

uint oldGridW()
{
    return g_C.tool;
}

uint oldGridH()
{
    return g_C.brushMode;
}

int2 regridOffset()
{
    return int2(int(g_C.emitType), int(g_C.parity));
}

// The cells (a wall around the new grid), at rest and at the ambient temperature where the old grid
// had nothing.
[numthreads(256, 1, 1)]
void regrid_grid_cs(uint3 id : SV_DispatchThreadID)
{
    const uint t = id.x;
    if (t < AIR_FLOATS)
    {
        u_Multigrid[t] = 0.0;
    }
    if (t >= g_C.stride)
    {
        return;
    }
    for (uint s = 0; s < F_TPRE; s++)
    {
        u_GridFloat[gi(s, t)] = 0.0;
    }
    for (uint g = 0; g < GLOW_SECTIONS; g++)
    {
        u_GridInt[gi(I_GLOW + g, t)] = 0;
    }
    u_GridInt[gi(I_SPARK, t)] = 0;
    u_GridInt[gi(I_SPARK + 1, t)] = 0;
    u_GridFloat[gi(F_TPRE, t)] = AMBIENT;
    u_GridFloat[gi(F_TSRC, t)] = AMBIENT;
    u_GridFloat[gi(F_TCELL, t)] = AMBIENT;
    u_GridFloat[gi(F_LIFE, t)] = 0.0;
    // The bodies (after the carried sections in the scratch), moved by the offset.
    if (t < MAX_BODIES * BODY_FLOATS)
    {
        const uint oldStride = (oldGridW() + 1) * (oldGridH() + 1);
        float value = asfloat(u_GridInt[(2 + F_LIFE - F_TPRE) * oldStride + t]);
        if (t % BODY_FLOATS == B_X)
        {
            value += float(regridOffset().x);
        }
        else if (t % BODY_FLOATS == B_Y)
        {
            value += float(regridOffset().y);
        }
        u_GridFloat[gi(F_BODY, t)] = value;
    }
    if (t >= g_C.gridW * g_C.gridH)
    {
        return;
    }
    const int x = int(t % g_C.gridW);
    const int y = int(t / g_C.gridW);
    uint m = EMPTY;
    if (x == 0 || y == 0 || x == int(g_C.gridW) - 1 || y == int(g_C.gridH) - 1)
    {
        m = WALL;
    }
    else
    {
        // The old grid's walls aren't carried over: they'd stand inside the new one.
        const int ow = int(oldGridW());
        const int oh = int(oldGridH());
        const int2 o = int2(x, y) - regridOffset();
        if (o.x >= 1 && o.y >= 1 && o.x < ow - 1 && o.y < oh - 1)
        {
            const uint oldStride = uint(ow + 1) * uint(oh + 1);
            const uint oldCell = uint(o.y) * uint(ow) + uint(o.x);
            m = uint(u_GridInt[oldCell]);
            for (uint k = 0; k <= F_LIFE - F_TPRE; k++)
            {
                u_GridFloat[gi(F_TPRE + k, t)] = asfloat(u_GridInt[(1 + k) * oldStride + oldCell]);
            }
        }
    }
    u_Cells[t] = m;
}

// The particles moved by the offset; those now outside the new grid's walls or in a solid cell freed.
// After regrid_grid_cs.
[numthreads(256, 1, 1)]
void regrid_particles_cs(uint3 id : SV_DispatchThreadID)
{
    const uint index = id.x;
    if (index >= g_C.capacity)
    {
        return;
    }
    Particle p = loadParticle(index);
    if (p.type == EMPTY)
    {
        return;
    }
    p.pos += float2(regridOffset());
    if (solidAt(p.pos))
    {
        p.type = EMPTY;
        storeParticle(index, p);
        freeParticle(index);
        return;
    }
    if (p.type == NEUTRON)
    {
        // Its birth cell's index in the new grid (none, if that's gone).
        const int2 birth = int2(int(p.origin % oldGridW()), int(p.origin / oldGridW())) + regridOffset();
        p.origin = inGrid(birth.x, birth.y) ? cellIndex(birth.x, birth.y) : 0xFFFFFFFFu;
    }
    storeParticle(index, p);
}

// --- A step ---

[numthreads(256, 1, 1)]
void clear_cs(uint3 id : SV_DispatchThreadID)
{
    if (id.x < g_C.stride * INT_SECTIONS)
    {
        u_GridInt[id.x] = 0;
    }
    if (id.x == 0 && g_C.substep == 0)
    {
        u_Alloc[A_VISCOUS] = 0;
    }
}

void splat(uint sumSection, uint weightSection, uint massSection, uint index, float w, float vel, float rho)
{
    InterlockedAdd(u_GridInt[gi(sumSection, index)], int(round(w * vel * VEL_SCALE)));
    InterlockedAdd(u_GridInt[gi(weightSection, index)], int(round(w * WEIGHT_SCALE)));
    InterlockedAdd(u_GridInt[gi(massSection, index)], int(round(w * rho * WEIGHT_SCALE)));
}

// A particle's viscosity (lava's falls as it heats up).
float viscosity(Particle p)
{
    if (p.type == HONEY)
    {
        return HONEY_VISCOSITY;
    }
    if (p.type == LAVA)
    {
        return lerp(LAVA_VISCOSITY_COLD, LAVA_VISCOSITY_HOT, saturate((p.temp - SOLIDIFY_LAVA) / (LAVA_TEMP - SOLIDIFY_LAVA)));
    }
    return 0.0;
}

void splatViscosity(uint section, uint index, float w, float nu)
{
    InterlockedAdd(u_GridInt[gi(section, index)], int(round(w * nu)));
}

// Particles to grid: the counts and temperatures of the cells; the liquids' and powders' momentum
// and mass on the faces.
[numthreads(256, 1, 1)]
void p2g_cs(uint3 id : SV_DispatchThreadID)
{
    if (id.x >= g_C.capacity)
    {
        return;
    }
    const Particle p = loadParticle(id.x);
    if (p.type == EMPTY)
    {
        return;
    }
    const int w = int(g_C.gridW);
    const int h = int(g_C.gridH);
    const int cx = clamp(int(floor(p.pos.x)), 0, w - 1);
    const int cy = clamp(int(floor(p.pos.y)), 0, h - 1);
    const uint c = cellIndex(cx, cy);
    InterlockedAdd(u_GridInt[gi(countSection(p.type), c)], 1);
    // (an ember's heat is only shown: it lights nothing)
    if (p.type != NEUTRON && p.type != EMBER)
    {
        InterlockedAdd(u_GridInt[gi(I_TSUM, c)], int(round(p.temp * TEMP_SCALE)));
        InterlockedAdd(u_GridInt[gi(I_TCOUNT, c)], 1);
    }
    if (p.type == WATER && p.life > 0.0)
    {
        InterlockedAdd(u_GridInt[gi(I_SALT, c)], int(round(p.life * SALT_SCALE)));
    }
    // (gunpowder and nitroglycerin going off, petrol and hydrogen lit: some grains' whoosh)
    const int blast = (p.type == GUNPOWDER && p.temp >= IGNITE_GUNPOWDER) ? 1 : ((p.type == NITRO && p.temp >= IGNITE_NITRO) ? NITRO_BLAST
        : (((p.type == PETROL && p.temp >= IGNITE_PETROL && id.x % PETROL_WHOOSH == 0)
        || (p.type == HYDROGEN && p.temp >= IGNITE_GAS && id.x % HYDROGEN_WHOOSH == 0)) ? 1 : 0));
    if (blast > 0)
    {
        InterlockedAdd(u_GridInt[gi(I_BLAST, c)], blast);
    }
    if (!isFlipMaterial(p.type))
    {
        return;
    }
    const float rho = particleDensity(p);
    const float nu = viscosity(p);
    if (!isPowder(p.type))
    {
        InterlockedAdd(u_GridInt[gi(I_LIQUID, c)], 1);
    }
    if (nu > 0.0 && u_Alloc[A_VISCOUS] == 0)
    {
        InterlockedOr(u_Alloc[A_VISCOUS], 1);
    }

    // u faces at (i, j + 0.5)
    {
        const float fx = p.pos.x;
        const float fy = p.pos.y - 0.5;
        const int i0 = clamp(int(floor(fx)), 0, w - 1);
        const int j0 = clamp(int(floor(fy)), 0, h - 2);
        const float tx = saturate(fx - i0);
        const float ty = saturate(fy - j0);
        splat(I_USUM, I_UW, I_UM, uIndex(i0, j0), (1 - tx) * (1 - ty), p.vel.x, rho);
        splat(I_USUM, I_UW, I_UM, uIndex(i0 + 1, j0), tx * (1 - ty), p.vel.x, rho);
        splat(I_USUM, I_UW, I_UM, uIndex(i0, j0 + 1), (1 - tx) * ty, p.vel.x, rho);
        splat(I_USUM, I_UW, I_UM, uIndex(i0 + 1, j0 + 1), tx * ty, p.vel.x, rho);
        if (nu > 0.0)
        {
            splatViscosity(I_UVISC, uIndex(i0, j0), (1 - tx) * (1 - ty), nu);
            splatViscosity(I_UVISC, uIndex(i0 + 1, j0), tx * (1 - ty), nu);
            splatViscosity(I_UVISC, uIndex(i0, j0 + 1), (1 - tx) * ty, nu);
            splatViscosity(I_UVISC, uIndex(i0 + 1, j0 + 1), tx * ty, nu);
        }
    }
    // v faces at (i + 0.5, j)
    {
        const float fx = p.pos.x - 0.5;
        const float fy = p.pos.y;
        const int i0 = clamp(int(floor(fx)), 0, w - 2);
        const int j0 = clamp(int(floor(fy)), 0, h - 1);
        const float tx = saturate(fx - i0);
        const float ty = saturate(fy - j0);
        splat(I_VSUM, I_VW, I_VM, vIndex(i0, j0), (1 - tx) * (1 - ty), p.vel.y, rho);
        splat(I_VSUM, I_VW, I_VM, vIndex(i0 + 1, j0), tx * (1 - ty), p.vel.y, rho);
        splat(I_VSUM, I_VW, I_VM, vIndex(i0, j0 + 1), (1 - tx) * ty, p.vel.y, rho);
        splat(I_VSUM, I_VW, I_VM, vIndex(i0 + 1, j0 + 1), tx * ty, p.vel.y, rho);
        if (nu > 0.0)
        {
            splatViscosity(I_VVISC, vIndex(i0, j0), (1 - tx) * (1 - ty), nu);
            splatViscosity(I_VVISC, vIndex(i0 + 1, j0), tx * (1 - ty), nu);
            splatViscosity(I_VVISC, vIndex(i0, j0 + 1), (1 - tx) * ty, nu);
            splatViscosity(I_VVISC, vIndex(i0 + 1, j0 + 1), tx * ty, nu);
        }
    }
}

// The face velocities and densities from the sums (kept as the FLIP update's old velocities), then
// gravity; zero at solid faces.
[numthreads(256, 1, 1)]
void grid_cs(uint3 id : SV_DispatchThreadID)
{
    const uint t = id.x;
    const int w = int(g_C.gridW);
    const int h = int(g_C.gridH);
    if (t < uint((w + 1) * h))
    {
        const int i = int(t % uint(w + 1));
        const int j = int(t / uint(w + 1));
        const int weight = u_GridInt[gi(I_UW, t)];
        float vel = 0.0;
        float rho = 1.0;
        if (weight > 0)
        {
            vel = float(u_GridInt[gi(I_USUM, t)]) / VEL_SCALE / (float(weight) / WEIGHT_SCALE);
            rho = float(u_GridInt[gi(I_UM, t)]) / float(weight);
        }
        if (solidCell(i - 1, j) || solidCell(i, j))
        {
            vel = 0.0;
        }
        u_GridFloat[gi(F_UOLD, t)] = vel;
        if (weight > 0 && !(solidCell(i - 1, j) || solidCell(i, j)))
        {
            vel += gravityAt(float2(i, j + 0.5)).x * g_C.dt;
        }
        u_GridFloat[gi(F_U, t)] = vel;
        u_GridFloat[gi(F_UA, t)] = 1.0 / max(rho, 0.1);
    }
    if (t < uint(w * (h + 1)))
    {
        const int i = int(t % uint(w));
        const int j = int(t / uint(w));
        const int weight = u_GridInt[gi(I_VW, t)];
        float vel = 0.0;
        float rho = 1.0;
        if (weight > 0)
        {
            vel = float(u_GridInt[gi(I_VSUM, t)]) / VEL_SCALE / (float(weight) / WEIGHT_SCALE);
            rho = float(u_GridInt[gi(I_VM, t)]) / float(weight);
        }
        const bool solid = solidCell(i, j - 1) || solidCell(i, j);
        u_GridFloat[gi(F_VOLD, t)] = solid ? 0.0 : vel;
        if (weight > 0)
        {
            vel += gravityAt(float2(i + 0.5, j)).y * g_C.dt;
        }
        u_GridFloat[gi(F_V, t)] = solid ? 0.0 : vel;
        u_GridFloat[gi(F_VA, t)] = 1.0 / max(rho, 0.1);
    }
}

// Rigid bodies: rectangles, MAX_BODIES records of BODY_FLOATS in F_BODY (saved with the state):
// active, center, angle (from x toward y, clockwise on screen), velocity, spin, half extents,
// density. bodies_cs moves them and draws them into the cells as BLOCK (the body in bits 8..11).
struct Body
{
    bool active;
    float2 pos;
    float angle;
    float2 vel;
    float spin;
    float2 half;
    float density;
};

Body loadBody(uint b)
{
    const uint base = b * BODY_FLOATS;
    Body body;
    body.active = gf(F_BODY, base + B_ACTIVE) != 0.0;
    body.pos = float2(gf(F_BODY, base + B_X), gf(F_BODY, base + B_Y));
    body.angle = gf(F_BODY, base + B_ANGLE);
    body.vel = float2(gf(F_BODY, base + B_VX), gf(F_BODY, base + B_VY));
    body.spin = gf(F_BODY, base + B_SPIN);
    body.half = float2(gf(F_BODY, base + B_HALFW), gf(F_BODY, base + B_HALFH));
    body.density = gf(F_BODY, base + B_DENSITY);
    return body;
}

void storeBody(uint b, Body body)
{
    const uint base = b * BODY_FLOATS;
    u_GridFloat[gi(F_BODY, base + B_ACTIVE)] = body.active ? 1.0 : 0.0;
    u_GridFloat[gi(F_BODY, base + B_X)] = body.pos.x;
    u_GridFloat[gi(F_BODY, base + B_Y)] = body.pos.y;
    u_GridFloat[gi(F_BODY, base + B_ANGLE)] = body.angle;
    u_GridFloat[gi(F_BODY, base + B_VX)] = body.vel.x;
    u_GridFloat[gi(F_BODY, base + B_VY)] = body.vel.y;
    u_GridFloat[gi(F_BODY, base + B_SPIN)] = body.spin;
    u_GridFloat[gi(F_BODY, base + B_HALFW)] = body.half.x;
    u_GridFloat[gi(F_BODY, base + B_HALFH)] = body.half.y;
    u_GridFloat[gi(F_BODY, base + B_DENSITY)] = body.density;
}

// A point in the body's own frame, and back.
float2 bodyLocal(Body body, float2 p)
{
    const float2 d = p - body.pos;
    const float c = cos(body.angle);
    const float s = sin(body.angle);
    return float2(c * d.x + s * d.y, -s * d.x + c * d.y);
}

float2 bodyWorld(Body body, float2 l)
{
    const float c = cos(body.angle);
    const float s = sin(body.angle);
    return body.pos + float2(c * l.x - s * l.y, s * l.x + c * l.y);
}

bool insideBody(Body body, float2 p)
{
    const float2 l = bodyLocal(body, p);
    return abs(l.x) <= body.half.x && abs(l.y) <= body.half.y;
}

float2 bodyPointVelocity(Body body, float2 p)
{
    const float2 r = p - body.pos;
    return body.vel + body.spin * float2(-r.y, r.x);
}

// The body a cell is drawn for, or MAX_BODIES.
uint cellBody(int x, int y)
{
    if (!inGrid(x, y))
    {
        return MAX_BODIES;
    }
    const uint word = u_Cells[cellIndex(x, y)];
    return (word & 0xFF) == BLOCK ? (word >> 8) & 15u : MAX_BODIES;
}

// A cell's liquid particles, capped at the rest count (over-full cells pulling harder would pack the
// liquid tighter and tighter); none in solid cells.
float liquidCount(int x, int y)
{
    return inGrid(x, y) && !solidCell(x, y) ? min(float(u_GridInt[gi(I_LIQUID, cellIndex(x, y))]), REST_COUNT) : 0.0;
}

// Surface tension's pull on a liquid particle in cell (x, y): toward the side of its 3 x 3 cells
// with more liquid, in cells a second squared (zero in the bulk; g2p_cs gives it the liquids, not
// powders).
float2 cohesion(int x, int y)
{
    float2 offset = float2(0.0, 0.0);
    float near = 0.0;
    for (int dy = -1; dy <= 1; dy++)
    {
        for (int dx = -1; dx <= 1; dx++)
        {
            const float n = liquidCount(x + dx, y + dy);
            offset += n * float2(dx, dy);
            near += n;
        }
    }
    // (most particles are in the bulk, their 3 x 3 cells full: no pull, and no 5 x 5 to look at)
    if (near >= 9.0 * REST_COUNT)
    {
        return float2(0.0, 0.0);
    }
    float around = near;
    for (int ry = -2; ry <= 2; ry++)
    {
        for (int rx = -2; rx <= 2; rx++)
        {
            if (abs(rx) == 2 || abs(ry) == 2)
            {
                around += liquidCount(x + rx, y + ry);
            }
        }
    }
    const float thin = saturate(1.0 - around / (TENSION_FULL * REST_COUNT));
    return near > 0.0 && thin > 0.0 ? thin * SURFACE_TENSION * offset / near : float2(0.0, 0.0);
}

// Viscosity: the faces' velocities diffused where the fluid is viscous, implicitly (stable at any
// viscosity), by red-black Gauss-Seidel sweeps of (1 + n a) u - a sum(u's neighbors) = u*, a = the
// face's viscosity * dt, u* the velocity grid_cs left (F_UOLD, plus gravity for v). Solid neighbors
// count at 0 (no slip), air ones not at all (no stress at the surface). Faces without viscosity are
// left as they are, so water is untouched. parity: the faces updated ((i + j) & 1).
float faceViscosity(uint viscSection, uint weightSection, uint t)
{
    const int weight = u_GridInt[gi(weightSection, t)];
    return weight > 0 ? float(u_GridInt[gi(viscSection, t)]) / (float(weight) / WEIGHT_SCALE) : 0.0;
}

void viscousNeighbor(bool isU, int i, int j, inout float sum, inout float n)
{
    const int w = int(g_C.gridW);
    const int h = int(g_C.gridH);
    bool solid;
    uint t;
    if (isU)
    {
        solid = i < 0 || i > w || j < 0 || j >= h || solidCell(i - 1, j) || solidCell(i, j);
        t = solid ? 0u : uIndex(i, j);
    }
    else
    {
        solid = i < 0 || i >= w || j < 0 || j > h || solidCell(i, j - 1) || solidCell(i, j);
        t = solid ? 0u : vIndex(i, j);
    }
    if (solid)
    {
        n += 1.0;
    }
    else if (u_GridInt[gi(isU ? I_UW : I_VW, t)] > 0)
    {
        sum += gf(isU ? F_U : F_V, t);
        n += 1.0;
    }
}

[numthreads(256, 1, 1)]
void viscosity_cs(uint3 id : SV_DispatchThreadID)
{
    const uint t = id.x;
    const int w = int(g_C.gridW);
    const int h = int(g_C.gridH);
    if (t < uint((w + 1) * h))
    {
        const int i = int(t % uint(w + 1));
        const int j = int(t / uint(w + 1));
        const float nu = faceViscosity(I_UVISC, I_UW, t);
        if (uint((i + j) & 1) == (g_C.parity & 1) && nu > 0.0 && !solidCell(i - 1, j) && !solidCell(i, j))
        {
            const float a = nu * g_C.dt;
            float sum = 0.0;
            float n = 0.0;
            viscousNeighbor(true, i - 1, j, sum, n);
            viscousNeighbor(true, i + 1, j, sum, n);
            viscousNeighbor(true, i, j - 1, sum, n);
            viscousNeighbor(true, i, j + 1, sum, n);
            u_GridFloat[gi(F_U, t)] = (gf(F_UOLD, t) + gravityAt(float2(i, j + 0.5)).x * g_C.dt + a * sum) / (1.0 + a * n);
        }
    }
    if (t < uint(w * (h + 1)))
    {
        const int i = int(t % uint(w));
        const int j = int(t / uint(w));
        const float nu = faceViscosity(I_VVISC, I_VW, t);
        if (uint((i + j) & 1) == (g_C.parity & 1) && nu > 0.0 && !solidCell(i, j - 1) && !solidCell(i, j))
        {
            const float a = nu * g_C.dt;
            float sum = 0.0;
            float n = 0.0;
            viscousNeighbor(false, i - 1, j, sum, n);
            viscousNeighbor(false, i + 1, j, sum, n);
            viscousNeighbor(false, i, j - 1, sum, n);
            viscousNeighbor(false, i, j + 1, sum, n);
            u_GridFloat[gi(F_V, t)] = (gf(F_VOLD, t) + gravityAt(float2(i + 0.5, j)).y * g_C.dt + a * sum) / (1.0 + a * n);
        }
    }
}

// Air: a coarse grid, a cell AIR_CELL x AIR_CELL of the simulation's, its velocity on the faces (in
// cells a second) at the start of u_Multigrid (AIR_U, AIR_V; not saved: the wind starts calm after a
// load). air_cs moves it a frame (parity: its steps) in one workgroup, at the frame's last step (a
// step at a time, the coarse grid's interpolation blurred a fan's jet away before it went anywhere): a coarse cell is blocked (solid) when as many of its
// cells as two lines across it are solid (fans let air through) or hold liquid, so walls two cells
// thick stop the wind (not the grid's one-cell border; past it the air is open, at pressure 0, so a
// fan blows through as through an open room, not round and round a closed box); fans push it, damping slows it, it carries itself along
// (semi-Lagrangian), and a pressure solve keeps it incompressible but for gunpowder's gas, which
// pushes it outward. Gases relax toward it, airborne grains
// are dragged by it.
groupshared float s_AirU[AIR_MAX_FACES];
groupshared float s_AirV[AIR_MAX_FACES];
// Bit 0 blocked, bits 1 and 2 the fans' direction, 3 .. 9 their cells, 10 and up gunpowder going off.
groupshared uint s_AirCell[AIR_MAX_CELLS];
groupshared float s_AirP[AIR_MAX_CELLS];
// (a coarse cell's gases' lift, a fraction of gravity: GAS_FULL a cell is all of theirs)
groupshared float s_AirLift[AIR_MAX_CELLS];
groupshared uint s_AirMax;

int airW()
{
    return int((g_C.gridW + AIR_CELL - 1) / AIR_CELL);
}

int airH()
{
    return int((g_C.gridH + AIR_CELL - 1) / AIR_CELL);
}

bool airOutside(int i, int j)
{
    return i < 0 || j < 0 || i >= airW() || j >= airH();
}

// (outside the grid is open air)
bool airBlocked(int i, int j)
{
    return !airOutside(i, j) && (s_AirCell[j * airW() + i] & 1u) != 0;
}

float airPressure(int i, int j)
{
    return airOutside(i, j) ? 0.0 : s_AirP[j * airW() + i];
}

// A coarse cell's fans' push: their direction, times their cells over AIR_CELL (a fan line across it
// pushes 1).
float2 airFans(int i, int j)
{
    if (i < 0 || j < 0 || i >= airW() || j >= airH())
    {
        return float2(0.0, 0.0);
    }
    const uint cell = s_AirCell[j * airW() + i];
    const uint dir = (cell >> 1) & 3u;
    const float2 direction = dir == 0 ? float2(1, 0) : (dir == 1 ? float2(0, 1) : (dir == 2 ? float2(-1, 0) : float2(0, -1)));
    return direction * float((cell >> 3) & 127u) / AIR_CELL;
}

// The gases' lift (a fraction of gravity) between two coarse cells: their mean, outside cells none.
float airLift(int i0, int j0, int i1, int j1)
{
    const bool in0 = i0 >= 0 && j0 >= 0 && i0 < airW() && j0 < airH();
    const bool in1 = i1 >= 0 && j1 >= 0 && i1 < airW() && j1 < airH();
    return 0.5 * ((in0 ? s_AirLift[j0 * airW() + i0] : 0.0) + (in1 ? s_AirLift[j1 * airW() + i1] : 0.0));
}

float sharedAirU(int i, int j)
{
    return s_AirU[clamp(j, 0, airH() - 1) * (airW() + 1) + clamp(i, 0, airW())];
}

float sharedAirV(int i, int j)
{
    return s_AirV[clamp(j, 0, airH()) * airW() + clamp(i, 0, airW() - 1)];
}

// The air's velocity at pos (in the simulation's cells), from the faces in groupshared memory.
float2 sharedAir(float2 pos)
{
    const float2 q = pos / AIR_CELL;
    const float2 a = q - float2(0.0, 0.5);
    const int2 ia = int2(floor(a));
    const float2 fa = a - float2(ia);
    const float u = lerp(lerp(sharedAirU(ia.x, ia.y), sharedAirU(ia.x + 1, ia.y), fa.x),
        lerp(sharedAirU(ia.x, ia.y + 1), sharedAirU(ia.x + 1, ia.y + 1), fa.x), fa.y);
    const float2 b = q - float2(0.5, 0.0);
    const int2 ib = int2(floor(b));
    const float2 fb = b - float2(ib);
    const float v = lerp(lerp(sharedAirV(ib.x, ib.y), sharedAirV(ib.x + 1, ib.y), fb.x),
        lerp(sharedAirV(ib.x, ib.y + 1), sharedAirV(ib.x + 1, ib.y + 1), fb.x), fb.y);
    return float2(u, v);
}

// The same from u_Multigrid (g2p_cs's).
float airU(int i, int j)
{
    return u_Multigrid[AIR_U + clamp(j, 0, airH() - 1) * (airW() + 1) + clamp(i, 0, airW())];
}

float airV(int i, int j)
{
    return u_Multigrid[AIR_V + clamp(j, 0, airH()) * airW() + clamp(i, 0, airW() - 1)];
}

float2 airVelocity(float2 pos)
{
    const float2 q = pos / AIR_CELL;
    const float2 a = q - float2(0.0, 0.5);
    const int2 ia = int2(floor(a));
    const float2 fa = a - float2(ia);
    const float u = lerp(lerp(airU(ia.x, ia.y), airU(ia.x + 1, ia.y), fa.x),
        lerp(airU(ia.x, ia.y + 1), airU(ia.x + 1, ia.y + 1), fa.x), fa.y);
    const float2 b = q - float2(0.5, 0.0);
    const int2 ib = int2(floor(b));
    const float2 fb = b - float2(ib);
    const float v = lerp(lerp(airV(ib.x, ib.y), airV(ib.x + 1, ib.y), fb.x),
        lerp(airV(ib.x, ib.y + 1), airV(ib.x + 1, ib.y + 1), fb.x), fb.y);
    return float2(u, v);
}

// The outward flux of a coarse cell's faces, over AIR_CELL (in cells a second).
float airOutflow(int i, int j)
{
    const int w = airW();
    return s_AirU[j * (w + 1) + i + 1] - s_AirU[j * (w + 1) + i] + s_AirV[(j + 1) * w + i] - s_AirV[j * w + i];
}

[numthreads(AIR_THREADS, 1, 1)]
void air_cs(uint3 id : SV_GroupThreadID)
{
    const uint tid = id.x;
    const int w = airW();
    const int h = airH();
    const uint cells = uint(w * h);
    const uint uFaces = uint((w + 1) * h);
    const uint vFaces = uint(w * (h + 1));
    const float steps = float(max(g_C.parity, 1u));
    const float dt = g_C.dt * steps;
    if (tid == 0)
    {
        s_AirMax = 0;
    }
    for (uint t = tid; t < uFaces; t += AIR_THREADS)
    {
        s_AirU[t] = u_Multigrid[AIR_U + t];
    }
    for (uint t = tid; t < vFaces; t += AIR_THREADS)
    {
        s_AirV[t] = u_Multigrid[AIR_V + t];
    }
    GroupMemoryBarrierWithGroupSync();

    // The coarse cells: blocked, fans, gunpowder.
    for (uint c = tid; c < cells; c += AIR_THREADS)
    {
        const int ci = int(c % uint(w));
        const int cj = int(c / uint(w));
        uint blocked = 0;
        uint fans = 0;
        uint dir = 3;
        uint blast = 0;
        float lift = 0.0;
        for (int y = cj * AIR_CELL; y < (cj + 1) * AIR_CELL; y++)
        {
            for (int x = ci * AIR_CELL; x < (ci + 1) * AIR_CELL; x++)
            {
                if (!inGrid(x, y))
                {
                    continue;
                }
                const uint k = cellIndex(x, y);
                const uint word = u_Cells[k];
                const uint m = word & 0xFF;
                if (m == FAN)
                {
                    fans++;
                    dir = (word >> 8) & 3u;
                }
                if ((isSolidMaterial(m) && m != FAN) || liquidCount(x, y) >= 2.0)
                {
                    blocked++;
                }
                // (the last step's, for the frame's)
                blast += uint(u_GridInt[gi(I_BLAST, k)]) * uint(steps);
                const int gases = gasCount(x, y);
                if (gases > 0)
                {
                    const float t = gf(F_TCELL, k);
                    lift += float(countOf(FIRE, x, y) + countOf(SMOKE, x, y)) * gasLift(FIRE, t) + float(countOf(STEAM, x, y)) * gasLift(STEAM, t);
                }
            }
        }
        const bool isBlocked = blocked >= 2 * AIR_CELL;
        s_AirCell[c] = (isBlocked ? 1u : 0u) | (dir << 1) | (min(fans, 127u) << 3) | (min(blast, 0x3FFFFFu) << 10);
        s_AirP[c] = isBlocked ? 0.0 : u_Multigrid[AIR_P + c];
        s_AirLift[c] = isBlocked ? 0.0 : lift / (GAS_FULL * AIR_CELL * AIR_CELL);
    }
    GroupMemoryBarrierWithGroupSync();

    // The faces: carried along, pushed by fans, damped (the faces of blocked cells still).
    float newU[AIR_PER_THREAD];
    float newV[AIR_PER_THREAD];
    uint k = 0;
    for (uint t = tid; t < uFaces; t += AIR_THREADS)
    {
        const int i = int(t % uint(w + 1));
        const int j = int(t / uint(w + 1));
        float u = 0.0;
        if (!airBlocked(i - 1, j) && !airBlocked(i, j))
        {
            const float2 at = float2(i, j + 0.5) * AIR_CELL;
            u = sharedAir(at - dt * sharedAir(at)).x;
            u += dt * FAN_ACCEL * 0.5 * (airFans(i - 1, j).x + airFans(i, j).x);
            u -= dt * AIR_LIFT * airLift(i - 1, j, i, j) * gravityAt(at).x;
            u = clamp(u * saturate(1.0 - AIR_DAMPING * dt), -WIND_MAX, WIND_MAX);
        }
        newU[k++] = u;
    }
    k = 0;
    for (uint t = tid; t < vFaces; t += AIR_THREADS)
    {
        const int i = int(t % uint(w));
        const int j = int(t / uint(w));
        float v = 0.0;
        if (!airBlocked(i, j - 1) && !airBlocked(i, j))
        {
            const float2 at = float2(i + 0.5, j) * AIR_CELL;
            v = sharedAir(at - dt * sharedAir(at)).y;
            v += dt * FAN_ACCEL * 0.5 * (airFans(i, j - 1).y + airFans(i, j).y);
            v -= dt * AIR_LIFT * airLift(i, j - 1, i, j) * gravityAt(at).y;
            v = clamp(v * saturate(1.0 - AIR_DAMPING * dt), -WIND_MAX, WIND_MAX);
        }
        newV[k++] = v;
    }
    GroupMemoryBarrierWithGroupSync();
    k = 0;
    for (uint t = tid; t < uFaces; t += AIR_THREADS)
    {
        s_AirU[t] = newU[k++];
    }
    k = 0;
    for (uint t = tid; t < vFaces; t += AIR_THREADS)
    {
        s_AirV[t] = newV[k++];
    }
    GroupMemoryBarrierWithGroupSync();

    // The pressure (a potential: the faces lose its difference over AIR_CELL), red-black SOR: a cell's
    // open neighbors' sum (0 outside) less its own times their count is AIR_CELL times its outflow
    // less its gunpowder's gas (as volume a second).
    for (uint iteration = 0; iteration < AIR_ITERATIONS; iteration++)
    {
        for (uint color = 0; color < 2; color++)
        {
            for (uint c = tid; c < cells; c += AIR_THREADS)
            {
                const int ci = int(c % uint(w));
                const int cj = int(c / uint(w));
                if (uint((ci + cj) & 1) != color || airBlocked(ci, cj))
                {
                    continue;
                }
                float sum = 0.0;
                float n = 0.0;
                for (int o = 0; o < 4; o++)
                {
                    const int ni = ci + sideOffset(o).x;
                    const int nj = cj + sideOffset(o).y;
                    if (!airBlocked(ni, nj))
                    {
                        sum += airPressure(ni, nj);
                        n += 1.0;
                    }
                }
                if (n > 0.0)
                {
                    const float gas = float(s_AirCell[c] >> 10) * BLAST_VOLUME / dt;
                    const float target = (sum - (AIR_CELL * airOutflow(ci, cj) - gas)) / n;
                    s_AirP[c] = lerp(s_AirP[c], target, AIR_OMEGA);
                }
            }
            GroupMemoryBarrierWithGroupSync();
        }
    }

    // Projected, and stored (the pressure too).
    for (uint c = tid; c < cells; c += AIR_THREADS)
    {
        u_Multigrid[AIR_P + c] = s_AirP[c];
    }
    for (uint t = tid; t < uFaces; t += AIR_THREADS)
    {
        const int i = int(t % uint(w + 1));
        const int j = int(t / uint(w + 1));
        float u = s_AirU[t];
        if (!airBlocked(i - 1, j) && !airBlocked(i, j))
        {
            u -= (airPressure(i, j) - airPressure(i - 1, j)) / AIR_CELL;
        }
        u_Multigrid[AIR_U + t] = u;
        InterlockedMax(s_AirMax, asuint(abs(u)));
    }
    for (uint t = tid; t < vFaces; t += AIR_THREADS)
    {
        const int i = int(t % uint(w));
        const int j = int(t / uint(w));
        float v = s_AirV[t];
        if (!airBlocked(i, j - 1) && !airBlocked(i, j))
        {
            v -= (airPressure(i, j) - airPressure(i, j - 1)) / AIR_CELL;
        }
        u_Multigrid[AIR_V + t] = v;
        InterlockedMax(s_AirMax, asuint(abs(v)));
    }
    GroupMemoryBarrierWithGroupSync();
    if (tid == 0)
    {
        u_Alloc[A_WIND] = int(s_AirMax);
    }
}

// The bodies, a workgroup each (after the pressure solve): the liquid's pressure on the faces of
// its cells (buoyancy), gravity and drag in liquid; contacts with solids (other bodies too) at
// points along its edges, pushed out and their closing velocity taken off, with friction (off its
// center, a contact turns it: blocks tip over); then its cells drawn again where it is now. A Block
// box painted makes one in the first free record; erasing over a body's center removes it.
groupshared float4 s_BodyForce[BODY_THREADS];
groupshared Body s_Body;

bool bodyContactSolid(float2 p, uint b)
{
    const int x = int(floor(p.x));
    const int y = int(floor(p.y));
    return solidCell(x, y) && cellBody(x, y) != b;
}

void bodyBounds(Body body, out int2 lo, out int2 hi)
{
    const float reach = length(body.half) + 1.0;
    lo = int2(max(int(floor(body.pos.x - reach)), 1), max(int(floor(body.pos.y - reach)), 1));
    hi = int2(min(int(floor(body.pos.x + reach)), int(g_C.gridW) - 2), min(int(floor(body.pos.y + reach)), int(g_C.gridH) - 2));
}

[numthreads(BODY_THREADS, 1, 1)]
void bodies_cs(uint3 group : SV_GroupID, uint3 thread : SV_GroupThreadID)
{
    const uint b = group.x;
    const uint tid = thread.x;
    if (b >= MAX_BODIES)
    {
        return;
    }
    // A Block box painted: a body in the first free record, made by the first group only (each
    // looking for the first free one, a group could see another's new body and make a second).
    if (b == 0 && tid == 0 && g_C.brushMode == 2 && g_C.tool == BLOCK)
    {
        uint first = MAX_BODIES;
        for (uint k = 0; k < MAX_BODIES && first == MAX_BODIES; k++)
        {
            if (gf(F_BODY, k * BODY_FLOATS + B_ACTIVE) == 0.0)
            {
                first = k;
            }
        }
        if (first < MAX_BODIES)
        {
            const float2 a = float2(g_C.brushX0, g_C.brushY0);
            const float2 c = float2(g_C.brushX1, g_C.brushY1);
            Body made;
            made.active = true;
            made.pos = 0.5 * (a + c);
            made.angle = 0.0;
            made.vel = float2(0.0, 0.0);
            made.spin = 0.0;
            made.half = max(0.5 * abs(c - a), float2(1.0, 1.0));
            made.density = BLOCK_DENSITY;
            storeBody(first, made);
        }
    }
    DeviceMemoryBarrierWithGroupSync();
    Body body = loadBody(b);
    if (!body.active)
    {
        return;
    }
    const float dt = g_C.dt;

    // The liquid's pressure on its cells' faces.
    int2 lo;
    int2 hi;
    bodyBounds(body, lo, hi);
    const int bw = max(hi.x - lo.x + 1, 0);
    const int bh = max(hi.y - lo.y + 1, 0);
    float4 sum = float4(0.0, 0.0, 0.0, 0.0);
    for (uint k = tid; k < uint(bw * bh); k += BODY_THREADS)
    {
        const int x = lo.x + int(k % uint(bw));
        const int y = lo.y + int(k / uint(bw));
        if (cellBody(x, y) != b)
        {
            continue;
        }
        for (int o = 0; o < 4; o++)
        {
            const int nx = x + sideOffset(o).x;
            const int ny = y + sideOffset(o).y;
            if (cellBody(nx, ny) != b && fluidCell(nx, ny))
            {
                const float pressure = gf(F_P, cellIndex(nx, ny)) / dt;
                const float2 force = -pressure * float2(sideOffset(o));
                const float2 r = (float2(x, y) + float2(nx, ny)) * 0.5 + 0.5 - body.pos;
                sum += float4(force, r.x * force.y - r.y * force.x, 1.0);
            }
        }
    }
    s_BodyForce[tid] = sum;
    GroupMemoryBarrierWithGroupSync();
    for (uint stride = BODY_THREADS / 2; stride > 0; stride >>= 1)
    {
        if (tid < stride)
        {
            s_BodyForce[tid] += s_BodyForce[tid + stride];
        }
        GroupMemoryBarrierWithGroupSync();
    }

    if (tid == 0)
    {
        const float4 total = s_BodyForce[0];
        const float2 size = 2.0 * body.half;
        const float mass = body.density * size.x * size.y;
        const float inertia = mass * dot(size, size) / 12.0;
        body.vel += (gravityAt(body.pos) + total.xy / mass) * dt;
        body.spin += total.z / inertia * dt;
        // Drag where it's wet (its faces against liquid over all of them).
        const float wet = saturate(total.w / (2.0 * (size.x + size.y)));
        body.vel *= saturate(1.0 - BODY_WATER_DRAG * wet * dt);
        body.spin *= saturate(1.0 - BODY_WATER_DRAG * wet * dt);
        body.pos += body.vel * dt;
        body.angle += body.spin * dt;

        // Contacts, at points a cell apart along its edges (twice over: a push can make another).
        const int2 samples = int2(ceil(size)) + 1;
        for (uint pass = 0; pass < 2; pass++)
        {
            for (int e = 0; e < 4; e++)
            {
                const int count = e < 2 ? samples.x : samples.y;
                for (int i = 0; i < count; i++)
                {
                    const float t = count > 1 ? float(i) / float(count - 1) * 2.0 - 1.0 : 0.0;
                    const float2 l = e == 0 ? float2(t * body.half.x, -body.half.y) : (e == 1 ? float2(t * body.half.x, body.half.y)
                        : (e == 2 ? float2(-body.half.x, t * body.half.y) : float2(body.half.x, t * body.half.y)));
                    const float2 p = bodyWorld(body, l);
                    if (!bodyContactSolid(p, b))
                    {
                        continue;
                    }
                    // Out of the solid cell the shortest way into a free one.
                    const float2 cell = floor(p);
                    const float4 depths = float4(p.x - cell.x, cell.x + 1.0 - p.x, p.y - cell.y, cell.y + 1.0 - p.y);
                    float depth = 1e9;
                    float2 n = float2(0.0, -1.0);
                    for (int d = 0; d < 4; d++)
                    {
                        if (depths[d] < depth && !bodyContactSolid(cell + 0.5 + float2(sideOffset(d)), b))
                        {
                            depth = depths[d];
                            n = float2(sideOffset(d));
                        }
                    }
                    if (depth > 1.0)
                    {
                        continue;
                    }
                    body.pos += n * (depth + 0.01);
                    const float2 r = p - body.pos;
                    const float2 vp = body.vel + body.spin * float2(-r.y, r.x);
                    const float vn = dot(vp, n);
                    if (vn < 0.0)
                    {
                        const float rn = r.x * n.y - r.y * n.x;
                        const float j = -(1.0 + BODY_RESTITUTION) * vn / (1.0 / mass + rn * rn / inertia);
                        body.vel += j * n / mass;
                        body.spin += rn * j / inertia;
                        const float2 tangent = float2(-n.y, n.x);
                        const float2 vq = body.vel + body.spin * float2(-r.y, r.x);
                        const float rt = r.x * tangent.y - r.y * tangent.x;
                        const float jt = clamp(-dot(vq, tangent) / (1.0 / mass + rt * rt / inertia), -BODY_FRICTION * j, BODY_FRICTION * j);
                        body.vel += jt * tangent / mass;
                        body.spin += rt * jt / inertia;
                    }
                }
            }
        }
        if (g_C.brushMode != 0 && g_C.tool == ERASE && insideBrush(body.pos))
        {
            body.active = false;
        }
        storeBody(b, body);
        s_Body = body;
    }
    GroupMemoryBarrierWithGroupSync();

    // Its cells drawn again: the old ones cleared, the new ones where they're free (not over solids
    // or other bodies; particles there are pushed out in g2p_cs).
    for (uint k = tid; k < uint(bw * bh); k += BODY_THREADS)
    {
        const int x = lo.x + int(k % uint(bw));
        const int y = lo.y + int(k / uint(bw));
        if (cellBody(x, y) == b)
        {
            u_Cells[cellIndex(x, y)] = EMPTY;
        }
    }
    DeviceMemoryBarrierWithGroupSync();
    const Body moved = s_Body;
    if (!moved.active)
    {
        return;
    }
    int2 lo2;
    int2 hi2;
    bodyBounds(moved, lo2, hi2);
    const int bw2 = max(hi2.x - lo2.x + 1, 0);
    const int bh2 = max(hi2.y - lo2.y + 1, 0);
    for (uint k = tid; k < uint(bw2 * bh2); k += BODY_THREADS)
    {
        const int x = lo2.x + int(k % uint(bw2));
        const int y = lo2.y + int(k / uint(bw2));
        if (insideBody(moved, float2(x, y) + 0.5) && !solidCell(x, y))
        {
            u_Cells[cellIndex(x, y)] = BLOCK | (b << 8);
        }
    }
}

// A level's goal: the particles of a material (tool), or the cells of a solid one, in the box
// (brushX0, brushY0) .. (brushX1, brushY1), counted into u_Alloc[A_GOAL] once a frame.
groupshared uint s_Goal;

[numthreads(256, 1, 1)]
void goal_cs(uint3 id : SV_GroupThreadID)
{
    const uint tid = id.x;
    if (tid == 0)
    {
        s_Goal = 0;
    }
    GroupMemoryBarrierWithGroupSync();
    const int w = int(g_C.gridW);
    const int h = int(g_C.gridH);
    const int x0 = clamp(int(floor(min(g_C.brushX0, g_C.brushX1))), 0, w - 1);
    const int y0 = clamp(int(floor(min(g_C.brushY0, g_C.brushY1))), 0, h - 1);
    const int x1 = clamp(int(floor(max(g_C.brushX0, g_C.brushX1))), 0, w - 1);
    const int y1 = clamp(int(floor(max(g_C.brushY0, g_C.brushY1))), 0, h - 1);
    const uint bw = uint(x1 - x0 + 1);
    const uint bh = uint(y1 - y0 + 1);
    const uint m = g_C.tool;
    uint count = 0;
    for (uint k = tid; k < bw * bh; k += 256)
    {
        const int x = x0 + int(k % bw);
        const int y = y0 + int(k / bw);
        count += m <= PARTICLE_TYPES ? uint(countOf(m, x, y)) : (cellMaterial(x, y) == m ? 1u : 0u);
    }
    InterlockedAdd(s_Goal, count);
    GroupMemoryBarrierWithGroupSync();
    if (tid == 0)
    {
        u_Alloc[A_GOAL] = int(s_Goal);
    }
}

// How fast heat crosses a cell's faces, per step (at most 0.25 for the explicit diffusion to stay
// stable with 4 faces).
float conductivity(int x, int y)
{
    const uint m = cellMaterial(x, y);
    if (m == WALL || m == EMITTER || m == FAN)
    {
        return 0.4;
    }
    if (m == GLASS || m == ICE)
    {
        return 0.5;
    }
    if (m == STONE)
    {
        return 0.3;
    }
    if (m == WOOD || m == BLOCK)
    {
        return 0.25;
    }
    if (m == URANIUM)
    {
        return 0.8;
    }
    if (m == METAL)
    {
        return 1.0;
    }
    if (flipCount(x, y) > 0)
    {
        return 0.7;
    }
    if (countOf(FIRE, x, y) + countOf(SMOKE, x, y) + countOf(STEAM, x, y) > 0)
    {
        return 0.3;
    }
    // Empty air: it holds little heat (a three-thousandth of rock's), so it takes little from what
    // it touches; lava cools in air over seconds, not at once.
    return 0.002;
}

// A cell's temperature this step: its particles' mean (or its own, for solids and empty air, which
// drifts back to the ambient), then the heat sources: uranium's decay and fissions, burning wood,
// the heat and cool brushes.
[numthreads(256, 1, 1)]
void heat_source_cs(uint3 id : SV_DispatchThreadID)
{
    const uint c = id.x;
    if (c >= g_C.gridW * g_C.gridH)
    {
        return;
    }
    const int x = int(c % g_C.gridW);
    const int y = int(c / g_C.gridW);
    const uint cell = u_Cells[c];
    const uint m = cell & 0xFF;
    const int n = u_GridInt[gi(I_TCOUNT, c)];
    float t = gf(F_TCELL, c);
    if (!isSolidMaterial(m))
    {
        if (n > 0)
        {
            t = float(u_GridInt[gi(I_TSUM, c)]) / TEMP_SCALE / float(n);
        }
        else
        {
            t += (AMBIENT - t) * saturate(0.5 * g_C.dt);
        }
    }
    const float before = t;
    if (m == URANIUM)
    {
        t += 20.0 * g_C.dt + 15.0 * float(u_GridInt[gi(I_FISSION, c)]);
    }
    if (m == HEATER && ((u_GridInt[gi(I_SPARK, c)] >> 8) & 0xFF) > 0 && t < HEATER_MAX)
    {
        t = min(t + HEATER_RATE * g_C.dt, HEATER_MAX);
    }
    if ((cell & BURNING) != 0)
    {
        t = max(t, 750.0);
    }
    if (g_C.brushMode != 0 && (g_C.tool == HEAT || g_C.tool == COOL) && insideBrush(float2(x, y) + 0.5))
    {
        t += (g_C.tool == HEAT ? 600.0 : -600.0) * g_C.dt;
    }
    t = clamp(t, -273.0, 5000.0);
    u_GridFloat[gi(F_TPRE, c)] = before;
    u_GridFloat[gi(F_TSRC, c)] = t;
}

// Heat diffusion between neighbors, then wood catching fire and burning away.
[numthreads(256, 1, 1)]
void heat_diffuse_cs(uint3 id : SV_DispatchThreadID)
{
    const uint c = id.x;
    if (c >= g_C.gridW * g_C.gridH)
    {
        return;
    }
    const int x = int(c % g_C.gridW);
    const int y = int(c / g_C.gridW);
    const float t = gf(F_TSRC, c);
    const float k = conductivity(x, y);
    float flow = 0.0;
    for (int i = 0; i < 4; i++)
    {
        const int nx = x + sideOffset(i).x;
        const int ny = y + sideOffset(i).y;
        if (inGrid(nx, ny))
        {
            flow += min(k, conductivity(nx, ny)) * 0.25 * (gf(F_TSRC, cellIndex(nx, ny)) - t);
        }
    }
    float next = t + flow;
    const uint cell = u_Cells[c];

    // Ice and stone hold at their melting point while the heat above it melts them.
    const uint m = cell & 0xFF;
    if (m == ICE || m == STONE || m == METAL)
    {
        const float meltAt = m == ICE ? 0.0 : (m == STONE ? MELT_STONE : MELT_METAL);
        if (next > meltAt)
        {
            const float taken = gf(F_LIFE, c) + (next - meltAt);
            next = meltAt;
            u_GridFloat[gi(F_LIFE, c)] = taken;
            if (taken >= (m == ICE ? LATENT_ICE : (m == STONE ? LATENT_STONE : LATENT_METAL)))
            {
                u_Cells[c] = EMPTY | MELTED | (m << 8);
            }
        }
    }
    u_GridFloat[gi(F_TCELL, c)] = next;

    if (m == C4 && (next > IGNITE_C4 || fireBeside(x, y) || sparkBeside(x, y)))
    {
        // (spawn_cs turns it into gunpowder going off)
        u_Cells[c] = EMPTY | MELTED | (C4 << 8);
    }
    if (m == WOOD || m == COAL || m == FUSE || m == PLANT)
    {
        if ((cell & BURNING) == 0)
        {
            // Hot enough, or a flame touching it (coal now and then); a fuse at a spark too, or from a
            // fuse beside it that's burned FUSE_PASS.
            bool touched = false;
            bool passed = false;
            for (int k = 0; k < 4; k++)
            {
                const int2 s = int2(x, y) + sideOffset(k);
                touched = touched || countOf(FIRE, s.x, s.y) > 0;
                passed = passed || (inGrid(s.x, s.y) && cellMaterial(s.x, s.y) == FUSE && (u_Cells[cellIndex(s.x, s.y)] & BURNING) != 0
                    && gf(F_LIFE, cellIndex(s.x, s.y)) <= FUSE_BURN - FUSE_PASS);
            }
            bool catches = m == WOOD || m == PLANT ? (next > (m == PLANT ? 200.0 : 280.0) || touched)
                : (m == COAL ? (next > IGNITE_COAL || (touched && random01(seedOf(c, 2)) < CATCH_COAL * g_C.dt))
                : (next > IGNITE_FUSE || touched || passed || sparkBeside(x, y)));
            if (catches)
            {
                u_Cells[c] = cell | BURNING;
                u_GridFloat[gi(F_LIFE, c)] = m == PLANT ? PLANT_BURN * (1.0 + 0.5 * random01(seedOf(c, 1))) : m == WOOD ? 3.0 + 2.0 * random01(seedOf(c, 1))
                    : (m == COAL ? COAL_BURN * (1.0 + 0.5 * random01(seedOf(c, 1))) : FUSE_BURN);
            }
        }
        else
        {
            const float life = gf(F_LIFE, c) - g_C.dt;
            u_GridFloat[gi(F_LIFE, c)] = life;
            if (life <= 0.0)
            {
                u_Cells[c] = EMPTY;
            }
        }
    }
}

// The fluid cells' divergence, less a little for cells packed fuller than REST_COUNT particles (it
// pushes them apart, so the volume holds); zero pressure outside the fluid.
[numthreads(256, 1, 1)]
void divergence_cs(uint3 id : SV_DispatchThreadID)
{
    const uint c = id.x;
    if (c >= g_C.gridW * g_C.gridH)
    {
        return;
    }
    const int x = int(c % g_C.gridW);
    const int y = int(c / g_C.gridW);
    if (!fluidCell(x, y))
    {
        u_GridFloat[gi(F_P, c)] = 0.0;
        u_GridFloat[gi(F_DIV, c)] = 0.0;
        return;
    }
    float div = gf(F_U, uIndex(x + 1, y)) - gf(F_U, uIndex(x, y)) + gf(F_V, vIndex(x, y + 1)) - gf(F_V, vIndex(x, y));
    // Inside the fluid (no air next to it) a sparse cell is drawn together too; at the surface only
    // a crowded one is pushed apart (the surface's cells are partly empty by nature).
    bool interior = true;
    for (int i = 0; i < 4; i++)
    {
        const int nx = x + sideOffset(i).x;
        const int ny = y + sideOffset(i).y;
        interior = interior && (solidCell(nx, ny) || flipCount(nx, ny) > 0);
    }
    float excess = clamp(float(flipCount(x, y)) / REST_COUNT - 1.0, -1.0, 2.0);
    if (!interior)
    {
        excess = max(excess, 0.0);
    }
    div -= excess / (16.0 * g_C.dt);
    // Gunpowder going off: its gas expands, pushing the cell's neighbors away.
    div -= float(u_GridInt[gi(I_BLAST, c)]) * BLAST_VOLUME / g_C.dt;
    u_GridFloat[gi(F_DIV, c)] = div;
}

// One red-black Gauss-Seidel sweep (over-relaxed) of the pressure Poisson equation with the faces'
// densities: sum over the faces of (p - p_neighbor) / rho = -div; solid faces left out, the air's
// pressure zero. The pressure kept from the last step starts it.
[numthreads(256, 1, 1)]
void pressure_cs(uint3 id : SV_DispatchThreadID)
{
    const uint c = id.x;
    if (c >= g_C.gridW * g_C.gridH)
    {
        return;
    }
    const int x = int(c % g_C.gridW);
    const int y = int(c / g_C.gridW);
    if (uint((x + y) & 1) != g_C.parity || !fluidCell(x, y))
    {
        return;
    }
    float diag = 0.0;
    float sum = 0.0;
    if (!solidCell(x + 1, y))
    {
        const float a = gf(F_UA, uIndex(x + 1, y));
        diag += a;
        sum += a * gf(F_P, cellIndex(x + 1, y));
    }
    if (!solidCell(x - 1, y))
    {
        const float a = gf(F_UA, uIndex(x, y));
        diag += a;
        sum += a * gf(F_P, cellIndex(x - 1, y));
    }
    if (!solidCell(x, y + 1))
    {
        const float a = gf(F_VA, vIndex(x, y + 1));
        diag += a;
        sum += a * gf(F_P, cellIndex(x, y + 1));
    }
    if (!solidCell(x, y - 1))
    {
        const float a = gf(F_VA, vIndex(x, y));
        diag += a;
        sum += a * gf(F_P, cellIndex(x, y - 1));
    }
    if (diag <= 0.0)
    {
        return;
    }
    const float p = gf(F_P, c);
    const float target = (sum - gf(F_DIV, c)) / diag;
    u_GridFloat[gi(F_P, c)] = p + g_C.omega * (target - p);
}

// --- Multigrid ---
//
// The same equation solved by V-cycles over a hierarchy of grids, each half the last's size: smooth
// (red-black Gauss-Seidel), hand the residual down to the coarser grid, solve there for the error,
// add it back and smooth again. A sweep only evens out the pressure between neighbors, so the
// fine grid alone (as SOR) takes many sweeps for the pressure across a whole vessel; the coarse
// grids carry that in a few.
//
// Level 0 is the simulation's own grid (F_P, F_DIV, F_UA, F_VA; pressure_cs smooths it). Levels 1
// and up live in u_Multigrid, each a block of x (the error being solved for), b (the residual
// handed down), type (0 solid, 1 fluid, 2 air: pressure 0) per cell, and the faces' coefficients
// (u faces, then v faces). A coarse cell is air if any of its four is, solid if all are, fluid
// otherwise; a coarse face's coefficient is the mean of the two finer faces on it (a missing one
// counts 0). The dispatches' level is in parity's bits 8 and up (its color in bit 0).


#define MG_SOLID 0
#define MG_FLUID 1
#define MG_AIR 2
// The coarsest level: at most this many cells, solved in one workgroup.
#define MG_COARSE_CELLS 256
#define MG_COARSE_ITERATIONS 64
#define MG_COARSE_OMEGA 1.5

struct MgLevel
{
    uint level;
    int w;
    int h;
    uint base;
};

uint mgDispatchLevel()
{
    return g_C.parity >> 8;
}

uint mgParity()
{
    return g_C.parity & 1;
}

MgLevel mgLevel(uint level)
{
    MgLevel l;
    l.level = level;
    l.base = AIR_FLOATS;
    for (uint k = 1; k < level; k++)
    {
        const uint w = (g_C.gridW + (1u << k) - 1u) >> k;
        const uint h = (g_C.gridH + (1u << k) - 1u) >> k;
        l.base += 3 * w * h + (w + 1) * h + w * (h + 1);
    }
    l.w = int((g_C.gridW + (1u << level) - 1u) >> level);
    l.h = int((g_C.gridH + (1u << level) - 1u) >> level);
    return l;
}

bool mgInside(MgLevel l, int x, int y)
{
    return x >= 0 && y >= 0 && x < l.w && y < l.h;
}

uint mgCell(MgLevel l, int x, int y)
{
    return uint(y * l.w + x);
}

uint mgType(MgLevel l, int x, int y)
{
    if (!mgInside(l, x, y))
    {
        return MG_SOLID;
    }
    if (l.level == 0)
    {
        return solidCell(x, y) ? MG_SOLID : (fluidCell(x, y) ? MG_FLUID : MG_AIR);
    }
    return uint(u_Multigrid[l.base + 2 * uint(l.w * l.h) + mgCell(l, x, y)]);
}

float mgX(MgLevel l, int x, int y)
{
    if (l.level == 0)
    {
        return gf(F_P, cellIndex(x, y));
    }
    return u_Multigrid[l.base + mgCell(l, x, y)];
}

void mgSetX(MgLevel l, int x, int y, float value)
{
    if (l.level == 0)
    {
        u_GridFloat[gi(F_P, cellIndex(x, y))] = value;
    }
    else
    {
        u_Multigrid[l.base + mgCell(l, x, y)] = value;
    }
}

float mgB(MgLevel l, int x, int y)
{
    if (l.level == 0)
    {
        return -gf(F_DIV, cellIndex(x, y));
    }
    return u_Multigrid[l.base + uint(l.w * l.h) + mgCell(l, x, y)];
}

// The u face at x = i on row j (between cells i - 1 and i), 0 where there's none or it's solid.
float mgAU(MgLevel l, int i, int j)
{
    if (i < 0 || j < 0 || i > l.w || j >= l.h)
    {
        return 0.0;
    }
    if (l.level == 0)
    {
        return solidCell(i - 1, j) || solidCell(i, j) ? 0.0 : gf(F_UA, uIndex(i, j));
    }
    return u_Multigrid[l.base + 3 * uint(l.w * l.h) + uint(j * (l.w + 1) + i)];
}

// The v face at y = j in column i (between cells j - 1 and j).
float mgAV(MgLevel l, int i, int j)
{
    if (i < 0 || j < 0 || i >= l.w || j > l.h)
    {
        return 0.0;
    }
    if (l.level == 0)
    {
        return solidCell(i, j - 1) || solidCell(i, j) ? 0.0 : gf(F_VA, vIndex(i, j));
    }
    return u_Multigrid[l.base + 3 * uint(l.w * l.h) + uint((l.w + 1) * l.h) + uint(j * l.w + i)];
}

// The equation at a fluid cell: diag x - sum = b, sum over the faces to fluid neighbors (air's x is 0).
void mgStencil(MgLevel l, int x, int y, out float diag, out float sum)
{
    diag = 0.0;
    sum = 0.0;
    const float a[4] = { mgAU(l, x + 1, y), mgAU(l, x, y), mgAV(l, x, y + 1), mgAV(l, x, y) };
    const int2 n[4] = { int2(x + 1, y), int2(x - 1, y), int2(x, y + 1), int2(x, y - 1) };
    for (uint k = 0; k < 4; k++)
    {
        const uint type = mgType(l, n[k].x, n[k].y);
        if (a[k] > 0.0 && type != MG_SOLID)
        {
            diag += a[k];
            if (type == MG_FLUID)
            {
                sum += a[k] * mgX(l, n[k].x, n[k].y);
            }
        }
    }
}

float mgResidual(MgLevel l, int x, int y)
{
    if (mgType(l, x, y) != MG_FLUID)
    {
        return 0.0;
    }
    float diag;
    float sum;
    mgStencil(l, x, y, diag, sum);
    return mgB(l, x, y) - (diag * mgX(l, x, y) - sum);
}

// Level L (1 and up)'s cells' types and faces from level L - 1's.
[numthreads(256, 1, 1)]
void mg_setup_cs(uint3 id : SV_DispatchThreadID)
{
    const MgLevel l = mgLevel(mgDispatchLevel());
    const MgLevel f = mgLevel(l.level - 1);
    const int t = int(id.x);
    const uint n = uint(l.w * l.h);
    if (t < l.w * l.h)
    {
        const int x = t % l.w;
        const int y = t / l.w;
        bool air = false;
        bool fluid = false;
        for (int k = 0; k < 4; k++)
        {
            const uint type = mgType(f, 2 * x + (k & 1), 2 * y + (k >> 1));
            air = air || type == MG_AIR;
            fluid = fluid || type == MG_FLUID;
        }
        u_Multigrid[l.base + 2 * n + uint(t)] = float(air ? MG_AIR : (fluid ? MG_FLUID : MG_SOLID));
    }
    if (t < (l.w + 1) * l.h)
    {
        const int i = t % (l.w + 1);
        const int j = t / (l.w + 1);
        u_Multigrid[l.base + 3 * n + uint(t)] = 0.5 * (mgAU(f, 2 * i, 2 * j) + mgAU(f, 2 * i, 2 * j + 1));
    }
    if (t < l.w * (l.h + 1))
    {
        const int i = t % l.w;
        const int j = t / l.w;
        u_Multigrid[l.base + 3 * n + uint((l.w + 1) * l.h) + uint(t)] = 0.5 * (mgAV(f, 2 * i, 2 * j) + mgAV(f, 2 * i + 1, 2 * j));
    }
}

// A red-black Gauss-Seidel sweep of level L (1 and up; level 0's is pressure_cs).
[numthreads(256, 1, 1)]
void mg_smooth_cs(uint3 id : SV_DispatchThreadID)
{
    const MgLevel l = mgLevel(mgDispatchLevel());
    const int t = int(id.x);
    if (t >= l.w * l.h)
    {
        return;
    }
    const int x = t % l.w;
    const int y = t / l.w;
    if (uint((x + y) & 1) != mgParity() || mgType(l, x, y) != MG_FLUID)
    {
        return;
    }
    float diag;
    float sum;
    mgStencil(l, x, y, diag, sum);
    if (diag > 0.0)
    {
        mgSetX(l, x, y, (mgB(l, x, y) + sum) / diag);
    }
}

// Level L's residual summed into level L + 1's b (its x zeroed: the error it solves for).
[numthreads(256, 1, 1)]
void mg_restrict_cs(uint3 id : SV_DispatchThreadID)
{
    const MgLevel f = mgLevel(mgDispatchLevel());
    const MgLevel l = mgLevel(f.level + 1);
    const int t = int(id.x);
    if (t >= l.w * l.h)
    {
        return;
    }
    const int x = t % l.w;
    const int y = t / l.w;
    float b = 0.0;
    if (mgType(l, x, y) == MG_FLUID)
    {
        for (int k = 0; k < 4; k++)
        {
            const int fx = 2 * x + (k & 1);
            const int fy = 2 * y + (k >> 1);
            if (mgInside(f, fx, fy))
            {
                b += mgResidual(f, fx, fy);
            }
        }
    }
    u_Multigrid[l.base + uint(t)] = 0.0;
    u_Multigrid[l.base + uint(l.w * l.h) + uint(t)] = b;
}

// Level L + 1's error added to level L's fluid cells (each takes its coarse cell's).
[numthreads(256, 1, 1)]
void mg_prolong_cs(uint3 id : SV_DispatchThreadID)
{
    const MgLevel l = mgLevel(mgDispatchLevel());
    const MgLevel c = mgLevel(l.level + 1);
    const int t = int(id.x);
    if (t >= l.w * l.h)
    {
        return;
    }
    const int x = t % l.w;
    const int y = t / l.w;
    if (mgType(l, x, y) == MG_FLUID)
    {
        mgSetX(l, x, y, mgX(l, x, y) + mgX(c, x >> 1, y >> 1));
    }
}

// The coarsest level (at most MG_COARSE_CELLS cells) solved in one workgroup: over-relaxed red-black
// sweeps over its x in group memory.
groupshared float s_X[MG_COARSE_CELLS];

[numthreads(MG_COARSE_CELLS, 1, 1)]
void mg_coarse_cs(uint3 id : SV_GroupThreadID)
{
    const MgLevel l = mgLevel(mgDispatchLevel());
    const int t = int(id.x);
    const bool mine = t < l.w * l.h;
    const int x = mine ? t % l.w : 0;
    const int y = mine ? t / l.w : 0;
    // The cell's faces to its fluid neighbors and their indices, its diagonal and b.
    float a[4] = { 0.0, 0.0, 0.0, 0.0 };
    int neighbor[4] = { 0, 0, 0, 0 };
    float diag = 0.0;
    float b = 0.0;
    bool solve = false;
    if (mine && mgType(l, x, y) == MG_FLUID)
    {
        const float faces[4] = { mgAU(l, x + 1, y), mgAU(l, x, y), mgAV(l, x, y + 1), mgAV(l, x, y) };
        const int2 n[4] = { int2(x + 1, y), int2(x - 1, y), int2(x, y + 1), int2(x, y - 1) };
        for (uint k = 0; k < 4; k++)
        {
            const uint type = mgType(l, n[k].x, n[k].y);
            if (faces[k] > 0.0 && type != MG_SOLID)
            {
                diag += faces[k];
                if (type == MG_FLUID)
                {
                    a[k] = faces[k];
                    neighbor[k] = n[k].y * l.w + n[k].x;
                }
            }
        }
        b = mgB(l, x, y);
        solve = diag > 0.0;
    }
    s_X[t] = 0.0;
    GroupMemoryBarrierWithGroupSync();
    const uint color = uint((x + y) & 1);
    for (uint i = 0; i < 2 * MG_COARSE_ITERATIONS; i++)
    {
        if (solve && color == (i & 1))
        {
            float sum = 0.0;
            for (uint k = 0; k < 4; k++)
            {
                sum += a[k] * s_X[neighbor[k]];
            }
            s_X[t] += MG_COARSE_OMEGA * ((b + sum) / diag - s_X[t]);
        }
        GroupMemoryBarrierWithGroupSync();
    }
    if (mine)
    {
        u_Multigrid[l.base + uint(t)] = s_X[t];
    }
}

// The pressure gradient off the faces next to the fluid: the velocity field is then divergence-free.
[numthreads(256, 1, 1)]
void project_cs(uint3 id : SV_DispatchThreadID)
{
    const uint t = id.x;
    const int w = int(g_C.gridW);
    const int h = int(g_C.gridH);
    if (t < uint((w + 1) * h))
    {
        const int i = int(t % uint(w + 1));
        const int j = int(t / uint(w + 1));
        if (solidCell(i - 1, j) || solidCell(i, j))
        {
            u_GridFloat[gi(F_U, t)] = 0.0;
        }
        else if (fluidCell(i - 1, j) || fluidCell(i, j))
        {
            const float pl = gf(F_P, cellIndex(i - 1, j));
            const float pr = gf(F_P, cellIndex(i, j));
            u_GridFloat[gi(F_U, t)] = gf(F_U, t) - gf(F_UA, t) * (pr - pl);
        }
    }
    if (t < uint(w * (h + 1)))
    {
        const int i = int(t % uint(w));
        const int j = int(t / uint(w));
        if (solidCell(i, j - 1) || solidCell(i, j))
        {
            u_GridFloat[gi(F_V, t)] = 0.0;
        }
        else if (fluidCell(i, j - 1) || fluidCell(i, j))
        {
            const float pt = gf(F_P, cellIndex(i, j - 1));
            const float pb = gf(F_P, cellIndex(i, j));
            u_GridFloat[gi(F_V, t)] = gf(F_V, t) - gf(F_VA, t) * (pb - pt);
        }
    }
}

// A face is valid (has a velocity worth sampling) when the fluid is on one side of it.
float sampleFaces(float2 p, bool isU, uint section)
{
    const int w = int(g_C.gridW);
    const int h = int(g_C.gridH);
    float fx;
    float fy;
    int i0;
    int j0;
    if (isU)
    {
        fx = p.x;
        fy = p.y - 0.5;
        i0 = clamp(int(floor(fx)), 0, w - 1);
        j0 = clamp(int(floor(fy)), 0, h - 2);
    }
    else
    {
        fx = p.x - 0.5;
        fy = p.y;
        i0 = clamp(int(floor(fx)), 0, w - 2);
        j0 = clamp(int(floor(fy)), 0, h - 1);
    }
    const float tx = saturate(fx - i0);
    const float ty = saturate(fy - j0);
    float sum = 0.0;
    float weight = 0.0;
    for (int k = 0; k < 4; k++)
    {
        const int i = i0 + (k & 1);
        const int j = j0 + (k >> 1);
        const float wk = ((k & 1) != 0 ? tx : 1.0 - tx) * ((k >> 1) != 0 ? ty : 1.0 - ty);
        bool valid;
        uint index;
        if (isU)
        {
            valid = fluidCell(i - 1, j) || fluidCell(i, j);
            index = uIndex(i, j);
        }
        else
        {
            valid = fluidCell(i, j - 1) || fluidCell(i, j);
            index = vIndex(i, j);
        }
        if (valid)
        {
            sum += wk * gf(section, index);
            weight += wk;
        }
    }
    return weight > 0.0 ? sum / weight : 0.0;
}

float2 sampleVelocity(float2 p, bool old)
{
    return float2(sampleFaces(p, true, old ? F_UOLD : F_U), sampleFaces(p, false, old ? F_VOLD : F_V));
}

// Moves p by move in steps of under half a cell, sliding along solid cells (which stop the velocity
// across them), so that nothing tunnels through a wall one cell thick.
void moveParticle(inout float2 pos, inout float2 vel, float2 move)
{
    const int steps = clamp(int(ceil(max(abs(move.x), abs(move.y)) / 0.45)), 1, 8);
    float2 d = move / float(steps);
    for (int s = 0; s < steps; s++)
    {
        const float2 next = pos + d;
        if (!solidAt(next))
        {
            pos = next;
        }
        else if (!solidAt(float2(next.x, pos.y)))
        {
            pos.x = next.x;
            vel.y = 0.0;
            d.y = 0.0;
        }
        else if (!solidAt(float2(pos.x, next.y)))
        {
            pos.y = next.y;
            vel.x = 0.0;
            d.x = 0.0;
        }
        else
        {
            vel = 0.0;
            break;
        }
    }
}

bool sandBlocked(int x, int y, int packed)
{
    return solidCell(x, y) || countOf(SAND, x, y) + countOf(SALT, x, y) + countOf(GUNPOWDER, x, y) >= packed;
}

// The mean salinity of a cell's water (0 with none).

// Acid eats this solid cell (not glass, nor the wall around the grid).
bool eatable(int x, int y)
{
    if (x <= 0 || y <= 0 || x >= int(g_C.gridW) - 1 || y >= int(g_C.gridH) - 1)
    {
        return false;
    }
    const uint m = cellMaterial(x, y);
    return isSolidMaterial(m) && m != GLASS;
}

// --- Electricity ---


// An iteration (its parity in g_C.substep picks the sections): batteries fire on their period; an
// idle conductor beside a live cell (or under the Spark tool's brush) goes live; the rest rest, then
// go idle; lamps shine.
[numthreads(256, 1, 1)]
void spark_cs(uint3 id : SV_DispatchThreadID)
{
    const uint c = id.x;
    if (c >= g_C.gridW * g_C.gridH)
    {
        return;
    }
    const int x = int(c % g_C.gridW);
    const int y = int(c / g_C.gridW);
    const uint from = I_SPARK + (g_C.substep & 1u);
    const uint to = I_SPARK + 1u - (g_C.substep & 1u);
    const uint m = cellMaterial(x, y);
    int next = 0;
    // (a battery's and a detector's beat)
    const bool beat = (g_C.frame * SPARK_ITERATIONS + g_C.substep) % BATTERY_PERIOD == 0;
    if (m == SWITCH)
    {
        // Touched by the Spark tool, it toggles (once a touch).
        const uint cell = u_Cells[c];
        const bool touched = g_C.brushMode != 0 && g_C.tool == SPARK && insideBrush(float2(x, y) + 0.5);
        uint changed = touched ? cell | SWITCH_TOUCHED : cell & ~SWITCH_TOUCHED;
        if (touched && (cell & SWITCH_TOUCHED) == 0)
        {
            changed ^= SWITCH_ON;
        }
        if (changed != cell)
        {
            u_Cells[c] = changed;
        }
    }
    if (m == BATTERY)
    {
        next = beat ? SPARK_LIVE : 0;
    }
    else if (m == DETECTOR)
    {
        // A particle beside it (any kind but neutrons and embers).
        int nearby = 0;
        for (int o = 0; o < 4; o++)
        {
            const int2 s = int2(x, y) + sideOffset(o);
            if (inGrid(s.x, s.y))
            {
                for (uint k = 0; k < PARTICLE_TYPES; k++)
                {
                    nearby += k == NEUTRON - 1 || k == EMBER - 1 ? 0 : u_GridInt[gi(I_COUNT + k, cellIndex(s.x, s.y))];
                }
            }
        }
        next = beat && nearby > 0 ? SPARK_LIVE : 0;
    }
    else if (conducts(x, y))
    {
        const int state = u_GridInt[gi(from, c)];
        const int phase = state & 0xFF;
        int nextPhase = 0;
        if (phase == 0)
        {
            bool sparked = g_C.brushMode != 0 && g_C.tool == SPARK && insideBrush(float2(x, y) + 0.5);
            for (int o = 0; o < 4; o++)
            {
                const int2 s = int2(x, y) + sideOffset(o);
                sparked = sparked || (inGrid(s.x, s.y) && (u_GridInt[gi(from, cellIndex(s.x, s.y))] & 0xFF) == SPARK_LIVE);
            }
            nextPhase = sparked ? SPARK_LIVE : 0;
        }
        else if (phase < SPARK_LIVE + SPARK_REST)
        {
            nextPhase = phase + 1;
        }
        // (lamps, and neon: lit)
        const bool glows = m == LAMP || m == HEATER || (m == EMPTY && countOf(NEON, x, y) >= 1);
        const int light = glows ? (nextPhase == SPARK_LIVE ? LAMP_HOLD : max(((state >> 8) & 0xFF) - 1, 0)) : 0;
        next = nextPhase | (light << 8);
    }
    u_GridInt[gi(to, c)] = next;
}

// An event of the step counted: the wave's at once (one atomic a wave, not a particle).
void countEvent(uint event, bool happened)
{
    const uint n = WaveActiveCountBits(happened);
    if (n > 0 && WaveIsFirstLane())
    {
        InterlockedAdd(u_GridInt[gi(I_EVENTS, event)], int(n));
    }
}

// Grid to particles: the liquids' and powders' new velocities (FLIP: the grid's change added to
// their own; sand takes the grid's, with friction where it rests), their moves; the gases' buoyancy;
// the neutrons' flight; temperatures and the changes they cause.
[numthreads(256, 1, 1)]
void g2p_cs(uint3 id : SV_DispatchThreadID)
{
    const uint index = id.x;
    if (index >= g_C.capacity)
    {
        return;
    }
    Particle p = loadParticle(index);
    if (p.type == EMPTY)
    {
        return;
    }
    const int w = int(g_C.gridW);
    const int h = int(g_C.gridH);
    const float dt = g_C.dt;
    bool kill = g_C.brushMode != 0 && g_C.tool == ERASE && insideBrush(p.pos);
    // (from the temperature p2g_cs saw, so each grain that went off there blasts once)
    const bool goesOff = (p.type == GUNPOWDER && p.temp >= IGNITE_GUNPOWDER) || (p.type == NITRO && p.temp >= IGNITE_NITRO);
    const bool petrolLit = p.type == PETROL && p.temp >= IGNITE_PETROL;
    const bool hydrogenLit = p.type == HYDROGEN && p.temp >= IGNITE_GAS;
    bool splash = false;
    bool fizz = false;
    const int cx = clamp(int(floor(p.pos.x)), 0, w - 1);
    const int cy = clamp(int(floor(p.pos.y)), 0, h - 1);
    const uint c = cellIndex(cx, cy);

    if (p.type != NEUTRON && p.type != EMBER)
    {
        // The cell's change, then the particles sharing it evening out toward its mean (which the
        // change made F_TCELL, so the heat is kept): water in a cell with lava boils.
        const float cellTemp = gf(F_TCELL, c);
        p.temp += cellTemp - gf(F_TPRE, c);
        if (!solidCell(cx, cy))
        {
            p.temp = lerp(p.temp, cellTemp, saturate(10.0 * dt));
        }
    }

    if (isFlipMaterial(p.type))
    {
        const float2 grid = sampleVelocity(p.pos, false);
        if (isPowder(p.type))
        {
            p.vel = grid;
            // Resting on something (below it, along the gravity): slide down a free diagonal, else
            // hold (static friction). (the pressure keeping a pile from compressing nudges it up a
            // little: still resting)
            int2 down;
            if (gravityDown(p.pos, down) && sandBlocked(cx + down.x, cy + down.y, 1) && dot(p.vel, normalize(float2(down))) > -20.0)
            {
                // (an empty cell 45 degrees either side of down, the one beside it on the way not
                // solid: a steeper slope than 45 degrees)
                const int2 slideA = turned45(down, -1);
                const int2 slideB = turned45(down, 1);
                const int2 besideA = slideA - down;
                const int2 besideB = slideB - down;
                const bool freeA = !sandBlocked(cx + slideA.x, cy + slideA.y, 1) && !solidCell(cx + besideA.x, cy + besideA.y);
                const bool freeB = !sandBlocked(cx + slideB.x, cy + slideB.y, 1) && !solidCell(cx + besideB.x, cy + besideB.y);
                const float2 across = normalize(float2(-down.y, down.x));
                const float sideways = dot(p.vel, across);
                float target = 0.0;
                if (freeA || freeB)
                {
                    float2 way = normalize(float2(freeA ? besideA : besideB));
                    if (freeA && freeB && random01(seedOf(index, 2)) < 0.5)
                    {
                        way = normalize(float2(besideB));
                    }
                    target = lerp(sideways, dot(way, across) * 12.0, 0.3);
                }
                // (else held by static friction: the pressure that levels liquids doesn't spread a pile)
                p.vel += across * (target - sideways);
            }
            // Airborne grains (and a pile's loose top: fewer than a packed cell's): dragged by the air.
            if (float(flipCount(cx, cy)) < REST_COUNT)
            {
                p.vel += (airVelocity(p.pos) - p.vel) * saturate(POWDER_DRAG * dt);
            }
            moveParticle(p.pos, p.vel, p.vel * dt);
        }
        else
        {
            const float2 old = sampleVelocity(p.pos, true);
            splash = length(grid - old) > SPLASH_SPEED;
            // (nitroglycerin jolted: heated to where it goes off, at the next step)
            if (p.type == NITRO && length(grid - old) > NITRO_SHOCK)
            {
                p.temp = max(p.temp, IGNITE_NITRO);
            }
            // (viscous liquids take the grid's velocity, PIC: their own would undo the diffusion)
            p.vel = lerp(grid, p.vel + (grid - old), viscosity(p) > 0.0 ? 0.0 : g_C.flip);
            // RK2 through the grid's velocity, plus the drift of a lighter or heavier particle
            // through the mixture around it (oil rising out of water): its buoyancy over a relaxation
            // time.
            const float2 mid = p.pos + 0.5 * dt * grid;
            const float mixture = 4.0 / (gf(F_UA, uIndex(cx, cy)) + gf(F_UA, uIndex(cx + 1, cy)) + gf(F_VA, vIndex(cx, cy))
                + gf(F_VA, vIndex(cx, cy + 1)));
            const float2 drift = (particleDensity(p) - mixture) / mixture * gravityAt(p.pos) * 0.08;
            // Surface tension: a pull on its velocity, not its position (a positional drift carries no
            // momentum: it held small drops up in the air, gravity never getting a fall going).
            p.vel += cohesion(cx, cy) * dt;
            moveParticle(p.pos, p.vel, (sampleVelocity(mid, false) + drift) * dt);
        }
    }
    else if (isGasMaterial(p.type))
    {
        // Lift against the gravity, from its heat; pushed from where gas is more crowded; wandering;
        // carried by the air; cooling (fire stays hot while it burns).
        p.vel -= gravityAt(p.pos) * gasLift(p.type, p.temp) * dt;
        const int n = gasCount(cx, cy);
        float2 crowd = float2(0.0, 0.0);
        for (int o = 0; o < 4; o++)
        {
            const int2 s = int2(cx, cy) + sideOffset(o);
            if (inGrid(s.x, s.y) && !solidCell(s.x, s.y))
            {
                crowd += float2(sideOffset(o)) * float(gasCount(s.x, s.y) - n);
            }
        }
        p.vel -= GAS_SPREAD * 0.5 * crowd * dt;
        const float jitter = p.type == FIRE ? 400.0 : (p.type == SMOKE ? 150.0 : 200.0);
        p.vel += (float2(random01(seedOf(index, 3)), random01(seedOf(index, 17))) - 0.5) * jitter * dt;
        p.vel = lerp(p.vel, airVelocity(p.pos), GAS_DRAG);
        if (p.type != FIRE)
        {
            p.temp = lerp(p.temp, AMBIENT, saturate(GAS_COOLING * dt));
        }
        moveParticle(p.pos, p.vel, p.vel * dt);
    }
    else if (p.type == EMBER)
    {
        // An ember: dragged along by the air (up a plume), falling a little, wandering, cooling; out
        // in water, or once cool.
        p.vel += gravityAt(p.pos) * EMBER_WEIGHT * dt;
        p.vel = lerp(p.vel, airVelocity(p.pos), saturate(EMBER_DRAG * dt));
        p.vel += (float2(random01(seedOf(index, 18)), random01(seedOf(index, 19))) - 0.5) * 300.0 * dt;
        p.temp = lerp(p.temp, AMBIENT, saturate(EMBER_COOLING * dt));
        p.life -= dt;
        kill = kill || p.life <= 0.0 || countOf(WATER, cx, cy) > 0;
        moveParticle(p.pos, p.vel, p.vel * dt);
    }
    else
    {
        // A neutron: straight on. Walls absorb it, uranium splits (outside its birth cell), water
        // slows and sometimes absorbs it.
        p.pos += p.vel * dt;
        const int nx = int(floor(p.pos.x));
        const int ny = int(floor(p.pos.y));
        if (!inGrid(nx, ny))
        {
            kill = true;
        }
        else
        {
            const uint n = cellIndex(nx, ny);
            const uint m = cellMaterial(nx, ny);
            if (m == WALL)
            {
                kill = true;
            }
            else if (m == URANIUM)
            {
                if (n != p.origin)
                {
                    InterlockedAdd(u_GridInt[gi(I_FISSION, n)], 1);
                    kill = true;
                }
            }
            else
            {
                p.origin = 0xFFFFFFFF;
                if (countOf(WATER, nx, ny) >= 2)
                {
                    p.vel *= 0.99;
                    kill = kill || random01(seedOf(index, 4)) < 0.003;
                }
            }
        }
        p.life -= dt;
        kill = kill || p.life <= 0.0;
    }

    // Salt water evens out with the water around it; salt in unsaturated water dissolves.
    if (p.type == WATER)
    {
        p.life = lerp(p.life, cellSalinity(c, cx, cy), saturate(SALT_MIX * dt));
    }
    else if (p.type == SALT && countOf(WATER, cx, cy) >= 2 && cellSalinity(c, cx, cy) < SATURATED
        && random01(seedOf(index, 10)) < DISSOLVE_RATE * dt)
    {
        p.type = WATER;
        p.life = 1.0;
    }
    else if (p.type == ACID && countOf(WATER, cx, cy) >= 1 && random01(seedOf(index, 14)) < DILUTE_RATE * dt)
    {
        p.type = WATER;
        p.life = 0.0;
        p.temp += DILUTE_HEAT;
        fizz = true;
    }

    // A spark in their cell or beside it lights gunpowder, petrol, oil and nitroglycerin (heated to
    // where they do), a flame nitroglycerin too.
    if ((p.type == GUNPOWDER || p.type == PETROL || p.type == OIL || p.type == NITRO) && sparkBeside(cx, cy))
    {
        p.temp = max(p.temp, p.type == GUNPOWDER ? IGNITE_GUNPOWDER : (p.type == PETROL ? IGNITE_PETROL : (p.type == OIL ? IGNITE_OIL : IGNITE_NITRO)));
    }
    if (p.type == NITRO && fireBeside(cx, cy))
    {
        p.temp = max(p.temp, IGNITE_NITRO);
    }
    // Hydrogen and oxygen beside a flame, or hot, catch (not at a spark: the electrode making them
    // would light them as they're made): hydrogen heated to where it lights (it burns at the next
    // step, its whoosh in that step's pressure), oxygen flaring at once.
    if ((p.type == HYDROGEN || p.type == OXYGEN) && !hydrogenLit && (p.temp >= IGNITE_GAS || fireBeside(cx, cy))
        && random01(seedOf(index, 20)) < CATCH_GAS * dt)
    {
        if (p.type == HYDROGEN)
        {
            p.temp = IGNITE_GAS;
        }
        else
        {
            p.type = FIRE;
            p.temp = OXYGEN_FIRE_TEMP;
            p.life = 0.3 + 0.3 * random01(seedOf(index, 23));
        }
    }
    // A current into water splits it now and then, at the electrode (a sparked metal cell beside it):
    // two parts hydrogen to one oxygen.
    if (p.type == WATER && electrodeBeside(cx, cy) && random01(seedOf(index, 21)) < ELECTROLYSIS_RATE)
    {
        p.type = random01(seedOf(index, 22)) < 0.667 ? HYDROGEN : OXYGEN;
        p.life = 0.0;
        fizz = true;
    }

    // Oil and petrol beside fire catch: heated to where they light (below). Only at their surface
    // (open to the air: the fire's heat would light a pool through), oil burning down from it.
    const bool exposed = (p.type == OIL || p.type == PETROL) && airBeside(cx, cy);
    const bool lit = exposed && (p.temp >= (p.type == OIL ? IGNITE_OIL : IGNITE_PETROL) || fireBeside(cx, cy));
    if (p.type == PETROL && !petrolLit && lit && random01(seedOf(index, 15)) < CATCH_PETROL * dt)
    {
        p.temp = max(p.temp, IGNITE_PETROL);
    }

    // What the temperature does. Gunpowder goes off; salt water boiling leaves its salt (as often
    // as it's salty).
    if (goesOff)
    {
        p.type = FIRE;
        p.temp = BLAST_TEMP;
        p.life = 0.4 + 0.4 * random01(seedOf(index, 12));
        p.vel += randomDirection(seedOf(index, 13)) * BLAST_SPEED;
    }
    else if (p.type == WATER && p.temp >= 100.0)
    {
        p.type = random01(seedOf(index, 11)) < p.life ? SALT : STEAM;
        fizz = true;
        p.life = 0.0;
        if (p.type == STEAM)
        {
            p.vel.y -= 20.0;
        }
    }
    else if (p.type == STEAM && p.temp < 90.0)
    {
        p.type = WATER;
    }
    else if (p.type == OIL && lit && random01(seedOf(index, 15)) < CATCH_OIL * dt)
    {
        p.type = FIRE;
        p.life = OIL_BURN + 2.0 * random01(seedOf(index, 5));
    }
    else if (hydrogenLit)
    {
        // (lit last step; it burns into water, as steam: see FIRE)
        p.type = FIRE;
        p.temp = HYDROGEN_FIRE_TEMP;
        p.life = 0.2 + 0.2 * random01(seedOf(index, 24));
        p.origin = HYDROGEN;
        p.vel += randomDirection(seedOf(index, 25)) * 30.0;
    }
    else if (p.type == THERMITE && (p.temp >= IGNITE_THERMITE || fireBeside(cx, cy) || countOf(LAVA, cx, cy) > 0)
        && random01(seedOf(index, 26)) < CATCH_THERMITE * dt)
    {
        // Burning into molten iron.
        p.type = LAVA;
        p.temp = THERMITE_TEMP;
        p.life = THERMITE_BURN * (0.5 + random01(seedOf(index, 29)));
        fizz = true;
    }
    else if (petrolLit)
    {
        // (lit last step, its whoosh in that step's pressure)
        p.type = FIRE;
        p.temp = PETROL_FIRE_TEMP;
        p.life = PETROL_BURN + 0.3 * random01(seedOf(index, 16));
        p.vel.y -= 30.0;
    }
    else if (p.type == FIRE)
    {
        p.temp = max(p.temp, 800.0);
        p.life -= dt;
        const int px = clamp(int(floor(p.pos.x)), 0, w - 1);
        const int py = clamp(int(floor(p.pos.y)), 0, h - 1);
        if (countOf(WATER, px, py) >= 2)
        {
            p.type = STEAM;
            p.temp = 105.0;
            p.life = 0.0;
        }
        else if (p.life <= 0.0)
        {
            if (p.origin == HYDROGEN)
            {
                // Burned hydrogen: water, as steam.
                p.type = STEAM;
                p.temp = 300.0;
                p.life = 0.0;
                p.origin = 0;
            }
            else if (random01(seedOf(index, 6)) < 0.35)
            {
                p.type = SMOKE;
                p.life = SMOKE_LIFE * (1.0 + random01(seedOf(index, 7)));
                p.temp = 300.0;
            }
            else
            {
                kill = true;
            }
        }
    }
    else if (p.type == SMOKE)
    {
        p.life -= dt;
        kill = kill || p.life <= 0.0;
    }

    // Acid: now and then, a solid next to it eaten (an empty cell), the acid used up. The cell is
    // claimed with a compare-exchange: of the acid around it, one takes it.
    if (p.type == ACID && !kill)
    {
        const int2 n = int2(floor(p.pos)) + sideOffset(int(hash(seedOf(index, 8)) & 3));
        if (eatable(n.x, n.y) && random01(seedOf(index, 9)) < ACID_RATE * dt)
        {
            const uint c = cellIndex(n.x, n.y);
            const uint before = u_Cells[c];
            uint original;
            InterlockedCompareExchange(u_Cells[c], before, EMPTY, original);
            kill = original == before;
            fizz = kill;
        }
    }

    if (p.type == LAVA && p.life > 0.0)
    {
        p.life -= dt;
        p.temp = max(p.temp, THERMITE_TEMP);
    }
    if (p.type == LAVA && p.temp >= THERMITE_CUT && !kill)
    {
        const int2 n = int2(floor(p.pos)) + sideOffset(int(hash(seedOf(index, 27)) & 3));
        if (inGrid(n.x, n.y) && cellMaterial(n.x, n.y) == METAL && random01(seedOf(index, 28)) < CUT_RATE * dt)
        {
            const uint c = cellIndex(n.x, n.y);
            const uint before = u_Cells[c];
            uint original;
            // (an open cell, the molten iron sinking into it: melted into lava cooler than the iron, the
            // cell would fill and stop it)
            InterlockedCompareExchange(u_Cells[c], before, EMPTY, original);
            if (original == before)
            {
                p.temp -= CUT_HEAT;
                fizz = true;
            }
        }
    }

    // In a body's cell (one drawn over it): out past its nearest edge, at its velocity.
    const uint inBody = cellBody(int(floor(p.pos.x)), int(floor(p.pos.y)));
    if (p.type != NEUTRON && inBody < MAX_BODIES)
    {
        const Body body = loadBody(inBody);
        float2 l = bodyLocal(body, p.pos);
        const float2 depth = body.half - abs(l);
        if (depth.x < depth.y)
        {
            l.x = (l.x >= 0.0 ? 1.0 : -1.0) * (body.half.x + 1.0);
        }
        else
        {
            l.y = (l.y >= 0.0 ? 1.0 : -1.0) * (body.half.y + 1.0);
        }
        p.pos = bodyWorld(body, l);
        p.vel = bodyPointVelocity(body, p.pos);
    }

    // Stuck in a solid (one painted over it): gone.
    if (p.type != NEUTRON && solidAt(p.pos))
    {
        kill = true;
    }

    // Beside a black hole: swallowed. Water beside a sponge with room: soaked up; beside a plant:
    // drunk. A seed where it's wet: a plant (its cell, if it's empty).
    if (!kill)
    {
        const int px = clamp(int(floor(p.pos.x)), 0, w - 1);
        const int py = clamp(int(floor(p.pos.y)), 0, h - 1);
        const int2 s = int2(px, py) + sideOffset(int(hash(seedOf(index, 30)) & 3));
        for (int o = 0; o < 4; o++)
        {
            const int2 n = int2(px, py) + sideOffset(o);
            kill = kill || (inGrid(n.x, n.y) && cellMaterial(n.x, n.y) == BLACK_HOLE);
        }
        if (!kill && p.type == WATER && inGrid(s.x, s.y))
        {
            const uint m = cellMaterial(s.x, s.y);
            const uint sc = cellIndex(s.x, s.y);
            const uint before = u_Cells[sc];
            const bool soaks = m == SPONGE && ((before >> 8) & 0xFF) < SPONGE_HOLD && random01(seedOf(index, 31)) < SOAK_RATE * dt;
            const bool drunk = m == PLANT && (before & BURNING) == 0 && ((before >> 8) & 0xFF) < 255 && random01(seedOf(index, 31)) < DRINK_RATE * dt;
            if (soaks || drunk)
            {
                uint original;
                InterlockedCompareExchange(u_Cells[sc], before, before + 0x100, original);
                kill = original == before;
            }
        }
        if (!kill && p.type == SEED && (countOf(WATER, px, py) > 0 || (inGrid(s.x, s.y) && countOf(WATER, s.x, s.y) > 0))
            && random01(seedOf(index, 32)) < SPROUT_RATE * dt)
        {
            const uint pc = cellIndex(px, py);
            uint original;
            InterlockedCompareExchange(u_Cells[pc], EMPTY, PLANT | (SEED_ENERGY << 8), original);
            kill = original == EMPTY;
        }
    }
    countEvent(EVENT_SPLASH, splash);
    countEvent(EVENT_FIZZ, fizz);
    countEvent(EVENT_FIRE, p.type == FIRE && !kill);
    countEvent(EVENT_BOOM, goesOff || (petrolLit && index % PETROL_WHOOSH == 0));
    if (kill)
    {
        p.type = EMPTY;
        storeParticle(index, p);
        freeParticle(index);
        return;
    }
    p.pos = clamp(p.pos, float2(0.001, 0.001), float2(w - 0.001, h - 0.001));
    storeParticle(index, p);
}

float2 randomInCell(int x, int y, uint seed)
{
    return float2(x + 0.05 + 0.9 * random01(seed), y + 0.05 + 0.9 * random01(seed + 1));
}

// New particles: the brush (and the materials it paints into cells), emitters, uranium's neutrons,
// burning wood's flames.
[numthreads(256, 1, 1)]
void spawn_cs(uint3 id : SV_DispatchThreadID)
{
    const uint c = id.x;
    if (c >= g_C.gridW * g_C.gridH)
    {
        return;
    }
    const int x = int(c % g_C.gridW);
    const int y = int(c / g_C.gridW);
    const int w = int(g_C.gridW);
    const int h = int(g_C.gridH);
    if (x == 0 || y == 0 || x == w - 1 || y == h - 1)
    {
        return;
    }
    const int reserve = int(g_C.capacity / 8);
    uint cell = u_Cells[c];
    uint m = cell & 0xFF;

    if (g_C.brushMode != 0 && insideBrush(float2(x, y) + 0.5))
    {
        const uint tool = g_C.tool;
        if (isFlipMaterial(tool) || tool == SALT_WATER)
        {
            if (!isSolidMaterial(m))
            {
                const float temp = tool == LAVA ? LAVA_TEMP : AMBIENT;
                const uint type = tool == SALT_WATER ? WATER : tool;
                const float salinity = tool == SALT_WATER ? 1.0 : 0.0;
                // An empty cell takes its new particles' temperature now, not at the next step's
                // heat_source_cs (before that the cell rules would see lava at the air's).
                if (flipCount(x, y) == 0)
                {
                    u_GridFloat[gi(F_TCELL, c)] = temp;
                }
                for (int k = flipCount(x, y); k < int(REST_COUNT); k++)
                {
                    spawn(type, randomInCell(x, y, seedOf(c, 10 + k * 2)), float2(0, 0), temp, salinity, 0, 0);
                }
            }
        }
        else if (tool == FIRE)
        {
            if (!isSolidMaterial(m) && random01(seedOf(c, 20)) < 0.5)
            {
                spawn(FIRE, randomInCell(x, y, seedOf(c, 21)), float2(0, 0), 800.0, 1.0 + random01(seedOf(c, 23)), 0, reserve);
            }
        }
        else if (isGasMaterial(tool))
        {
            // (hydrogen, oxygen, neon: up to two a cell)
            if (!isSolidMaterial(m) && countOf(tool, x, y) < 2 && random01(seedOf(c, 20)) < 0.5)
            {
                spawn(tool, randomInCell(x, y, seedOf(c, 21)), float2(0, 0), AMBIENT, 0.0, 0, reserve);
            }
        }
        else if (isSolidMaterial(tool) && (tool < ERASE || tool >= FIRST_SOLID_AFTER_TOOLS) && tool != BLOCK)
        {
            // (the tools from ERASE on paint no material: Heat and Cool act in heat_source_cs)
            const uint painted = tool | (tool == EMITTER || tool == FAN ? g_C.emitType << 8 : 0);
            // (a fan painted over again takes the new direction)
            if (m != tool || (tool == FAN && u_Cells[c] != painted))
            {
                u_Cells[c] = painted;
                u_GridFloat[gi(F_TCELL, c)] = tool == ICE ? ICE_TEMP : AMBIENT;
                u_GridFloat[gi(F_LIFE, c)] = 0.0;
            }
        }
        else if (tool == ERASE)
        {
            u_Cells[c] = EMPTY;
        }
        return;
    }

    if ((cell & MELTED) != 0)
    {
        // Melted ice, stone or metal: a cell full of water or lava. C-4 gone off: gunpowder going off.
        const uint was = (cell >> 8) & 0xFF;
        if (was == C4)
        {
            for (int k = 0; k < C4_GRAINS; k++)
            {
                spawn(GUNPOWDER, randomInCell(x, y, seedOf(c, 70 + k * 2)), float2(0, 0), IGNITE_GUNPOWDER, 0.0, 0, 0);
            }
        }
        else
        {
            for (int k = 0; k < int(REST_COUNT); k++)
            {
                spawn(was == ICE ? WATER : LAVA, randomInCell(x, y, seedOf(c, 70 + k * 2)), float2(0, 0),
                    was == ICE ? 0.5 : (was == METAL ? MELT_METAL : MELT_STONE), 0.0, 0, 0);
            }
        }
        u_Cells[c] = EMPTY;
        u_GridFloat[gi(F_LIFE, c)] = 0.0;
        return;
    }
    if (m == EMPTY)
    {
        // Embers off fire, and off lava's surface (with nothing above it, against the gravity).
        const float dt = g_C.dt;
        const int fires = min(countOf(FIRE, x, y), 4);
        int2 down;
        if (fires > 0 && random01(seedOf(c, 80)) < EMBER_RATE * float(fires) * dt)
        {
            spawn(EMBER, randomInCell(x, y, seedOf(c, 81)), randomDirection(seedOf(c, 83)) * 40.0, EMBER_TEMP,
                EMBER_LIFE * (0.5 + random01(seedOf(c, 84))), 0, reserve);
        }
        else if (countOf(LAVA, x, y) >= 2 && gravityDown(float2(x, y) + 0.5, down) && flipCount(x - down.x, y - down.y) == 0
            && !solidCell(x - down.x, y - down.y) && random01(seedOf(c, 85)) < LAVA_EMBER_RATE * dt)
        {
            spawn(EMBER, randomInCell(x - down.x, y - down.y, seedOf(c, 86)),
                -float2(down) * 60.0 + randomDirection(seedOf(c, 88)) * 30.0, EMBER_TEMP,
                EMBER_LIFE * (0.5 + random01(seedOf(c, 89))), 0, reserve);
        }

        // Water cold enough freezes, lava cool enough sets (its particles end up inside the solid,
        // and g2p frees them).
        const float t = gf(F_TCELL, c);
        uint solid = EMPTY;
        if (countOf(WATER, x, y) >= 2 && t < FREEZE_WATER)
        {
            solid = ICE;
        }
        else if (countOf(LAVA, x, y) >= 2 && t < SOLIDIFY_LAVA)
        {
            solid = STONE;
        }
        if (solid != EMPTY)
        {
            u_Cells[c] = solid;
            u_GridFloat[gi(F_LIFE, c)] = 0.0;
        }
        return;
    }

    if (m == CLONE && ((cell >> 8) & 0xFF) == 0)
    {
        // Not yet learned: the first particle type beside it (but neutrons and embers).
        uint learned = 0;
        for (int o = 0; o < 4 && learned == 0; o++)
        {
            const int2 s = int2(x, y) + sideOffset(o);
            for (uint k = 0; k < PARTICLE_TYPES && learned == 0; k++)
            {
                const uint t = k < EMBER ? k + 1 : k - EMBER + HYDROGEN;
                learned = t != NEUTRON && t != EMBER && u_GridInt[gi(I_COUNT + k, cellIndex(s.x, s.y))] > 0 ? t : 0;
            }
        }
        if (learned != 0)
        {
            u_Cells[c] = CLONE | (learned << 8);
        }
        return;
    }
    if (m == SPONGE)
    {
        // Its water spreads through it, a particle a step to a drier side; hot, it lets it out, a
        // particle a step, into a side with room. (Atomic: the sides do the same at once.)
        const uint held = (cell >> 8) & 0xFF;
        const int2 s = int2(x, y) + sideOffset(int(hash(seedOf(c, 90)) & 3));
        if (held > 0 && inGrid(s.x, s.y))
        {
            const uint side = u_Cells[cellIndex(s.x, s.y)];
            if ((side & 0xFF) == SPONGE && ((side >> 8) & 0xFF) < held)
            {
                InterlockedAdd(u_Cells[cellIndex(s.x, s.y)], 0x100u);
                InterlockedAdd(u_Cells[c], 0xFFFFFF00u);
            }
            else if (gf(F_TCELL, c) > SPONGE_SQUEEZE && !solidCell(s.x, s.y) && flipCount(s.x, s.y) < int(REST_COUNT))
            {
                spawn(WATER, randomInCell(s.x, s.y, seedOf(c, 91)), float2(0, 0), gf(F_TCELL, c), 0.0, 0, 0);
                InterlockedAdd(u_Cells[c], 0xFFFFFF00u);
            }
        }
        return;
    }
    if (m == PLANT)
    {
        // With energy, now and then a cell grows up (or 45 degrees either side of up), the new one
        // taking the rest of it.
        const uint energy = (cell >> 8) & 0xFF;
        if (energy > 0 && (cell & BURNING) == 0 && random01(seedOf(c, 92)) < GROW_RATE * g_C.dt)
        {
            int2 down;
            int2 up = int2(0, -1);
            if (gravityDown(float2(x, y) + 0.5, down))
            {
                up = -down;
            }
            else
            {
                up = sideOffset(int(hash(seedOf(c, 95)) & 3));
            }
            const float pick = random01(seedOf(c, 93));
            const int2 way = pick < 0.5 ? up : turned45(up, pick < 0.75 ? 1 : -1);
            const int2 s = int2(x, y) + way;
            if (inGrid(s.x, s.y) && cellMaterial(s.x, s.y) == EMPTY && flipCount(s.x, s.y) == 0)
            {
                u_Cells[cellIndex(s.x, s.y)] = PLANT | ((energy - 1) << 8);
                u_Cells[c] = cell & ~0xFF00u;
            }
        }
    }
    if (m == EMITTER || (m == CLONE && ((cell >> 8) & 0xFF) != 0))
    {
        const uint emitted = (cell >> 8) & 0xFF;
        for (int i = 0; i < 4; i++)
        {
            const int nx = x + sideOffset(i).x;
            const int ny = y + sideOffset(i).y;
            if (solidCell(nx, ny))
            {
                continue;
            }
            const uint seed = seedOf(c, 30 + i * 3);
            if (isFlipMaterial(emitted))
            {
                if (flipCount(nx, ny) < 2 && random01(seed) < 0.5)
                {
                    spawn(emitted, randomInCell(nx, ny, seed + 1), float2(sideOffset(i)) * 10.0, emitted == LAVA ? LAVA_TEMP : AMBIENT, 0.0, 0, 0);
                }
            }
            else if (emitted == FIRE && random01(seed) < 0.25)
            {
                spawn(FIRE, randomInCell(nx, ny, seed + 1), float2(0, 0), 800.0, 1.0 + random01(seed + 2), 0, reserve);
            }
            else if (isGasMaterial(emitted) && countOf(emitted, nx, ny) < 2 && random01(seed) < 0.25)
            {
                spawn(emitted, randomInCell(nx, ny, seed + 1), float2(sideOffset(i)) * 10.0, AMBIENT, 0.0, 0, reserve);
            }
        }
    }
    else if (m == URANIUM)
    {
        // Decay, now and then; each fission frees two more, about half the time each.
        const int fissions = min(u_GridInt[gi(I_FISSION, c)], 4);
        if (random01(seedOf(c, 40)) < 0.0015)
        {
            spawn(NEUTRON, float2(x, y) + 0.5, randomDirection(seedOf(c, 41)) * 120.0, AMBIENT, 1.0, c, reserve);
        }
        for (int k = 0; k < fissions * 2; k++)
        {
            if (random01(seedOf(c, 50 + k * 2)) < 0.4)
            {
                spawn(NEUTRON, float2(x, y) + 0.5, randomDirection(seedOf(c, 51 + k * 2)) * 120.0, AMBIENT, 1.0, c, reserve);
            }
        }
    }
    else if ((m == WOOD || m == COAL || m == FUSE) && (cell & BURNING) != 0)
    {
        if (!solidCell(x, y - 1) && random01(seedOf(c, 60)) < (m == WOOD ? 0.2 : (m == COAL ? 0.05 : 0.5)))
        {
            spawn(FIRE, randomInCell(x, y - 1, seedOf(c, 61)), float2(0, 0), 800.0, 0.6 + 0.6 * random01(seedOf(c, 63)), 0, reserve);
        }
    }
}

// --- Glow ---

// The light a cell gives off: what's hot enough to glow (solid, or with particles in it: not the hot
// air), fire, embers, burning wood, uranium.
float3 cellLight(int x, int y)
{
    const uint c = cellIndex(x, y);
    const uint cell = u_Cells[c];
    const uint m = cell & 0xFF;
    float3 light = float3(0.0, 0.0, 0.0);
    if (isSolidMaterial(m) || flipCount(x, y) > 0)
    {
        light += heatColor(gf(F_TCELL, c));
    }
    light += float3(1.0, 0.45, 0.1) * 0.35 * float(min(countOf(FIRE, x, y), 4));
    light += float3(1.0, 0.55, 0.15) * 0.8 * float(min(countOf(EMBER, x, y), 2));
    if ((m == WOOD || m == COAL || m == FUSE) && (cell & BURNING) != 0)
    {
        light += float3(1.0, 0.4, 0.08) * (m == FUSE ? 0.9 : 0.5);
    }
    else if (m == URANIUM)
    {
        light += float3(0.25, 0.8, 0.2) * 0.3;
    }
    else if (m == LAMP)
    {
        light += float3(1.0, 0.85, 0.55) * 1.2 * saturate(float((u_GridInt[gi(I_SPARK, c)] >> 8) & 0xFF) / 10.0);
    }
    else if (m == WHITE_HOLE)
    {
        light += float3(0.7, 0.75, 0.9) * 0.4;
    }
    else if (m == EMPTY && countOf(NEON, x, y) > 0)
    {
        light += NEON_COLOR * 1.2 * saturate(float((u_GridInt[gi(I_SPARK, c)] >> 8) & 0xFF) / 10.0);
    }
    const int phase = u_GridInt[gi(I_SPARK, c)] & 0xFF;
    if (phase >= SPARK_LIVE && phase <= SPARK_LIVE + 1)
    {
        light += float3(0.55, 0.75, 1.0) * 0.6;
    }
    return light;
}

[numthreads(256, 1, 1)]
void glow_emit_cs(uint3 id : SV_DispatchThreadID)
{
    const uint c = id.x;
    if (c >= g_C.gridW * g_C.gridH)
    {
        return;
    }
    const float3 light = cellLight(int(c % g_C.gridW), int(c / g_C.gridW));
    u_GridInt[gi(I_GLOW, c)] = int(round(light.r * GLOW_SCALE));
    u_GridInt[gi(I_GLOW + 1, c)] = int(round(light.g * GLOW_SCALE));
    u_GridInt[gi(I_GLOW + 2, c)] = int(round(light.b * GLOW_SCALE));
    const uint m = u_Cells[c] & 0xFF;
    u_GridInt[gi(I_HOLE, c)] = m == BLACK_HOLE ? int(GLOW_SCALE) : (m == WHITE_HOLE ? -int(GLOW_SCALE) : 0);
}

// The glow's sections from (and the hole field's after them), blurred along step into those at to
// (the grid's edge dark beyond).
void glowBlur(uint c, int2 step, uint from, uint to)
{
    const int2 at = int2(int(c % g_C.gridW), int(c / g_C.gridW));
    float3 sum = float3(0.0, 0.0, 0.0);
    float hole = 0.0;
    float weights = 0.0;
    for (int i = -GLOW_RADIUS; i <= GLOW_RADIUS; i++)
    {
        // (the weight from i, not a table: see sideOffset)
        const float weight = exp(-float(i * i) / (2.0 * GLOW_SIGMA * GLOW_SIGMA));
        weights += weight;
        const int2 s = at + step * i;
        if (inGrid(s.x, s.y))
        {
            const uint n = cellIndex(s.x, s.y);
            sum += weight * float3(float(u_GridInt[gi(from, n)]), float(u_GridInt[gi(from + 1, n)]), float(u_GridInt[gi(from + 2, n)]));
            hole += weight * float(u_GridInt[gi(from + 3, n)]);
        }
    }
    sum /= weights;
    u_GridInt[gi(to, c)] = int(round(sum.r));
    u_GridInt[gi(to + 1, c)] = int(round(sum.g));
    u_GridInt[gi(to + 2, c)] = int(round(sum.b));
    u_GridInt[gi(to + 3, c)] = int(round(hole / weights));
}

[numthreads(256, 1, 1)]
void glow_x_cs(uint3 id : SV_DispatchThreadID)
{
    if (id.x < g_C.gridW * g_C.gridH)
    {
        glowBlur(id.x, int2(1, 0), I_GLOW, I_GLOW_X);
    }
}

[numthreads(256, 1, 1)]
void glow_y_cs(uint3 id : SV_DispatchThreadID)
{
    if (id.x < g_C.gridW * g_C.gridH)
    {
        glowBlur(id.x, int2(0, 1), I_GLOW_X, I_GLOW);
    }
}

// The HUD's readout at the probed cell: temperature, pressure (in cells of water depth), material,
// the particles in it.
[numthreads(1, 1, 1)]
void probe_cs(uint3 id : SV_DispatchThreadID)
{
    const int x = clamp(int(floor(g_C.probeX)), 0, int(g_C.gridW) - 1);
    const int y = clamp(int(floor(g_C.probeY)), 0, int(g_C.gridH) - 1);
    const uint c = cellIndex(x, y);
    u_Alloc[A_PROBE + 0] = asint(gf(F_TCELL, c));
    u_Alloc[A_PROBE + 1] = asint(gf(F_P, c) / (g_C.dt * g_C.gravity));
    u_Alloc[A_PROBE + 2] = int(u_Cells[c]);
    // The count sections' counts four to an int (8 bits each, the first of four lowest), from
    // A_PROBE + 3 up to under the wind at A_PROBE + 9: up to 24 types. (u_Alloc is saved, so A_LIST
    // stays put.)
    for (uint k = 0; k < (PARTICLE_TYPES + 3) / 4; k++)
    {
        uint packed = 0u;
        for (uint j = 0; j < 4; j++)
        {
            const uint s = 4 * k + j;
            packed |= (s < PARTICLE_TYPES ? min(uint(u_GridInt[gi(I_COUNT + s, c)]), 255u) : 0u) << (8 * j);
        }
        u_Alloc[A_PROBE + 3 + k] = int(packed);
    }
    u_Alloc[A_LIST - 1] = asint(cellSalinity(c, x, y));
    // The wind there (u_Alloc[A_PROBE + 9 .. 10], under A_WIND).
    const float2 wind = airVelocity(float2(x, y) + 0.5);
    u_Alloc[A_PROBE + 9] = asint(wind.x);
    u_Alloc[A_PROBE + 10] = asint(wind.y);
}

#endif // SIMULATION

// --- Display ---------------------------------------------------------------------------------

#ifndef SIMULATION

StructuredBuffer<int> t_GridInt : register(t0);
StructuredBuffer<float> t_GridFloat : register(t1);
StructuredBuffer<uint> t_Cells : register(t2);

void display_vs(uint vertexId : SV_VertexID, out float4 position : SV_Position)
{
    const float2 uv = float2((vertexId << 1) & 2, vertexId & 2);
    position = float4(uv * float2(2, -2) + float2(-1, 1), 0, 1);
}

float sectionAt(uint section, int x, int y)
{
    x = clamp(x, 0, int(g_C.gridW) - 1);
    y = clamp(y, 0, int(g_C.gridH) - 1);
    return float(t_GridInt[section * g_C.stride + cellIndex(x, y)]);
}

int countAt(uint material, int x, int y)
{
    return int(sectionAt(countSection(material), x, y));
}

// An int section, bilinearly between the cell centers.
float sampleSection(float2 g, uint section)
{
    const float2 q = g - 0.5;
    const int2 i0 = int2(floor(q));
    const float2 f = q - float2(i0);
    return lerp(lerp(sectionAt(section, i0.x, i0.y), sectionAt(section, i0.x + 1, i0.y), f.x),
        lerp(sectionAt(section, i0.x, i0.y + 1), sectionAt(section, i0.x + 1, i0.y + 1), f.x), f.y);
}

// A material's particle count, bilinearly between the cell centers.
float sampleCount(float2 g, uint material)
{
    return sampleSection(g, countSection(material));
}

float floatAt(uint section, int x, int y)
{
    x = clamp(x, 0, int(g_C.gridW) - 1);
    y = clamp(y, 0, int(g_C.gridH) - 1);
    return t_GridFloat[section * g_C.stride + cellIndex(x, y)];
}

float sampleFloat(float2 g, uint section)
{
    const float2 q = g - 0.5;
    const int2 i0 = int2(floor(q));
    const float2 f = q - float2(i0);
    return lerp(lerp(floatAt(section, i0.x, i0.y), floatAt(section, i0.x + 1, i0.y), f.x),
        lerp(floatAt(section, i0.x, i0.y + 1), floatAt(section, i0.x + 1, i0.y + 1), f.x), f.y);
}

float3 materialColor(uint m)
{
    switch (m)
    {
    case WATER: return float3(0.12, 0.38, 0.9);
    case OIL: return float3(0.72, 0.5, 0.12);
    case SAND: return float3(0.86, 0.74, 0.44);
    case FIRE: return float3(1.0, 0.5, 0.1);
    case SMOKE: return float3(0.4, 0.4, 0.42);
    case STEAM: return float3(0.85, 0.88, 0.92);
    case NEUTRON: return float3(0.5, 1.0, 0.4);
    case LAVA: return float3(0.55, 0.12, 0.03);
    case ACID: return float3(0.45, 0.92, 0.18);
    case SALT: return float3(0.92, 0.92, 0.95);
    case GUNPOWDER: return float3(0.2, 0.2, 0.22);
    case HONEY: return float3(0.85, 0.55, 0.1);
    case PETROL: return float3(0.95, 0.88, 0.5);
    case EMBER: return float3(1.0, 0.55, 0.15);
    case HYDROGEN: return float3(0.85, 0.92, 1.0);
    case OXYGEN: return float3(0.55, 0.72, 1.0);
    case NEON: return float3(0.85, 0.45, 0.4);
    case THERMITE: return float3(0.5, 0.32, 0.28);
    case NITRO: return float3(0.86, 0.9, 0.62);
    case C4: return float3(0.84, 0.8, 0.68);
    case COAL: return float3(0.13, 0.12, 0.12);
    case FUSE: return float3(0.42, 0.3, 0.2);
    case SEED: return float3(0.55, 0.45, 0.2);
    case CLONE: return float3(0.85, 0.85, 0.3);
    case BLACK_HOLE: return float3(0.03, 0.0, 0.05);
    case WHITE_HOLE: return float3(0.95, 0.95, 1.0);
    case SPONGE: return float3(0.9, 0.85, 0.45);
    case PLANT: return float3(0.2, 0.6, 0.15);
    case SWITCH: return float3(0.45, 0.2, 0.2);
    case DETECTOR: return float3(0.75, 0.3, 0.6);
    case HEATER: return float3(0.5, 0.3, 0.25);
    case WALL: return float3(0.42, 0.42, 0.45);
    case GLASS: return float3(0.6, 0.85, 0.92);
    case WOOD: return float3(0.45, 0.28, 0.12);
    case URANIUM: return float3(0.25, 0.65, 0.2);
    case EMITTER: return float3(0.62, 0.22, 0.62);
    case ICE: return float3(0.75, 0.92, 1.0);
    case STONE: return float3(0.33, 0.3, 0.29);
    case METAL: return float3(0.6, 0.64, 0.7);
    case FAN: return float3(0.3, 0.5, 0.58);
    case BLOCK: return float3(0.72, 0.52, 0.3);
    case BATTERY: return float3(0.22, 0.22, 0.26);
    case LAMP: return float3(0.4, 0.37, 0.28);
    }
    return float3(0.0, 0.0, 0.0);
}

// Cold blue, ambient black, then red, yellow, white.
float3 temperatureRamp(float t)
{
    if (t < AMBIENT)
    {
        return float3(0.1, 0.3, 1.0) * saturate((AMBIENT - t) / 120.0);
    }
    const float x = saturate(log2(1.0 + (t - AMBIENT) / 40.0) / 5.0);
    return float3(saturate(x * 2.0), saturate(x * 2.0 - 0.7), saturate(x * 3.0 - 2.0));
}

#define SHIMMER 0.3

float4 display_ps(float4 position : SV_Position) : SV_Target
{
    float2 g = (position.xy - float2(g_C.viewX, g_C.viewY)) / g_C.cellPixels;
    if (any(g < 0.0) || g.x >= float(g_C.gridW) || g.y >= float(g_C.gridH))
    {
        return float4(0.02, 0.02, 0.03, 1.0);
    }
    // Hot air shimmers: what's seen through it wavers (up to SHIMMER cells), the hotter the more.
    {
        const int2 a = int2(floor(g));
        const float hot = isSolidMaterial(t_Cells[cellIndex(a.x, a.y)] & 0xFF) ? 0.0 : saturate((floatAt(F_TCELL, a.x, a.y) - 60.0) / 300.0);
        g += SHIMMER * hot * float2(sin(g.y * 1.9 + g_C.time * 11.0), sin(g.x * 1.3 - g_C.time * 8.0 + g.y * 0.7));
        g = clamp(g, 0.001, float2(g_C.gridW, g_C.gridH) - 0.001);
    }
    const int2 c = int2(floor(g));
    const uint cell = t_Cells[cellIndex(c.x, c.y)];
    const uint m = cell & 0xFF;
    const float t = floatAt(F_TCELL, c.x, c.y);
    float3 color = float3(0.05, 0.06, 0.08);

    // Liquids and sand: a smooth surface through the counts.
    const float water = sampleCount(g, WATER);
    const float oil = sampleCount(g, OIL);
    const float sand = sampleCount(g, SAND);
    const float lava = sampleCount(g, LAVA);
    const float acid = sampleCount(g, ACID);
    const float salt = sampleCount(g, SALT);
    const float gunpowder = sampleCount(g, GUNPOWDER);
    const float honey = sampleCount(g, HONEY);
    const float petrol = sampleCount(g, PETROL);
    const float thermite = sampleCount(g, THERMITE);
    const float nitro = sampleCount(g, NITRO);
    const float seed = sampleCount(g, SEED);
    const float total = water + oil + sand + lava + acid + salt + gunpowder + honey + petrol + thermite + nitro + seed;
    if (total > 0.01)
    {
        // Salt water a greener blue, the saltier the more (fully at 40%: seawater's a tenth of that).
        const float salinity = saturate(2.5 * sampleSection(g, I_SALT) / SALT_SCALE / max(water, 0.5));
        const float3 waterColor = lerp(materialColor(WATER), float3(0.1, 0.55, 0.62), salinity);
        float3 liquid = (water * waterColor + oil * materialColor(OIL) + sand * materialColor(SAND)
            + lava * materialColor(LAVA) + acid * materialColor(ACID) + salt * materialColor(SALT)
            + gunpowder * materialColor(GUNPOWDER) + honey * materialColor(HONEY) + petrol * materialColor(PETROL)
            + thermite * materialColor(THERMITE) + nitro * materialColor(NITRO) + seed * materialColor(SEED)) / total;
        if (sand + salt + gunpowder + thermite + seed > water + oil + lava + acid + honey + petrol + nitro)
        {
            // Grains
            const uint2 grain = uint2(g * 3.0);
            liquid *= 0.85 + 0.3 * random01(grain.x * 7919u + grain.y * 104729u);
        }
        color = lerp(color, liquid, smoothstep(0.8, 2.0, total));
    }

    // Gases over them.
    const float smoke = sampleCount(g, SMOKE);
    const float steam = sampleCount(g, STEAM);
    const float fire = sampleCount(g, FIRE);
    color = lerp(color, materialColor(SMOKE), saturate(smoke * 0.35));
    color = lerp(color, materialColor(STEAM), saturate(steam * 0.3));
    // Hydrogen and oxygen faint; neon faint, but shining where a current runs through it.
    color = lerp(color, materialColor(HYDROGEN), saturate(sampleCount(g, HYDROGEN) * 0.08));
    color = lerp(color, materialColor(OXYGEN), saturate(sampleCount(g, OXYGEN) * 0.12));
    const float neon = sampleCount(g, NEON);
    color = lerp(color, materialColor(NEON), saturate(neon * 0.15));
    color += NEON_COLOR * saturate(neon) * saturate(float((int(sectionAt(I_SPARK, c.x, c.y)) >> 8) & 0xFF) / 10.0);
    const float flicker = 0.8 + 0.2 * sin(g_C.time * 23.0 + g.x * 1.7 + g.y * 2.3);
    color += materialColor(FIRE) * saturate(fire * 0.6) * flicker + float3(1.0, 0.85, 0.4) * saturate(fire * 0.25 - 0.3);

    if (countAt(NEUTRON, c.x, c.y) > 0 && length(frac(g) - 0.5) < 0.35)
    {
        color = lerp(color, materialColor(NEUTRON), 0.85);
    }
    // Embers: bright flickering specks, dimming as they cool.
    const float ember = sampleCount(g, EMBER);
    color += materialColor(EMBER) * saturate(ember * 2.0) * (0.75 + 0.25 * sin(g_C.time * 37.0 + g.x * 5.0 + g.y * 3.0));

    if (isSolidMaterial(m))
    {
        const float2 f = frac(g);
        const float edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
        float3 solid = materialColor(m);
        if (m == GLASS)
        {
            color = lerp(color, solid, 0.45) + 0.15 * (1.0 - smoothstep(0.0, 0.2, edge));
        }
        else if (m == ICE)
        {
            // Frosted: mostly opaque, lighter at the cells' edges.
            color = lerp(color, solid, 0.75) + 0.1 * (1.0 - smoothstep(0.0, 0.25, edge));
        }
        else
        {
            if (m == WALL)
            {
                solid *= 0.9 + 0.1 * random01(uint(c.x) * 31u + uint(c.y) * 17u);
            }
            else if (m == WOOD)
            {
                solid *= 0.85 + 0.15 * sin(g.y * 9.0 + sin(g.x * 1.3) * 2.0);
                if ((cell & BURNING) != 0)
                {
                    solid = lerp(solid, float3(1.0, 0.4, 0.08), 0.6 + 0.3 * sin(g_C.time * 17.0 + c.x * 3.1 + c.y * 1.9));
                }
            }
            else if (m == URANIUM)
            {
                solid *= 0.8 + 0.4 * saturate((t - AMBIENT) / 300.0);
            }
            else if (m == METAL)
            {
                // Brushed: faint streaks along x.
                solid *= 0.9 + 0.12 * random01(uint(c.y) * 7919u + uint(g.x * 0.25) * 31u);
            }
            else if (m == STONE)
            {
                solid *= 0.8 + 0.3 * random01(uint(c.x) * 131u + uint(c.y) * 977u);
            }
            else if (m == EMITTER)
            {
                solid = length(f - 0.5) < 0.22 ? materialColor((cell >> 8) & 0xFF) : solid;
            }
            else if (m == BLOCK)
            {
                // A shade a body, planks across it.
                solid *= 0.85 + 0.05 * float((cell >> 8) & 3u) + 0.08 * step(0.5, frac(g.y * 0.34));
            }
            else if (m == CLONE)
            {
                // A frame, its learned material in the middle.
                const uint learned = (cell >> 8) & 0xFF;
                solid = learned != 0 && length(f - 0.5) < 0.25 ? materialColor(learned) : solid * (0.8 + 0.2 * step(0.25, edge));
            }
            else if (m == BLACK_HOLE || m == WHITE_HOLE)
            {
                // A swirl.
                const float2 d = f - 0.5;
                solid = lerp(solid, m == BLACK_HOLE ? float3(0.35, 0.1, 0.5) : float3(0.6, 0.7, 1.0),
                    0.5 + 0.5 * sin(atan2(d.y, d.x) * 3.0 + length(d) * 12.0 - g_C.time * 6.0));
            }
            else if (m == SPONGE)
            {
                // Holes; wetter, darker and bluer.
                const float wet = float((cell >> 8) & 0xFF) / float(SPONGE_HOLD);
                solid *= 0.8 + 0.3 * step(0.3, random01(uint(g.x * 3.0) * 7919u + uint(g.y * 3.0) * 104729u));
                solid = lerp(solid, float3(0.35, 0.45, 0.6), 0.6 * wet);
            }
            else if (m == PLANT)
            {
                // Leaves, a lighter green where it still has energy to grow; burning, orange.
                solid *= 0.8 + 0.35 * random01(uint(c.x) * 131u + uint(c.y) * 977u);
                solid = lerp(solid, float3(0.45, 0.85, 0.3), saturate(float((cell >> 8) & 0xFF) / 4.0) * 0.5);
                if ((cell & BURNING) != 0)
                {
                    solid = lerp(solid, float3(1.0, 0.45, 0.1), 0.6 + 0.3 * sin(g_C.time * 17.0 + c.x * 3.1 + c.y * 1.9));
                }
            }
            else if (m == SWITCH)
            {
                // Red when off, green when on.
                solid = (cell & SWITCH_ON) != 0 ? float3(0.2, 0.6, 0.25) : solid;
                solid *= 0.85 + 0.15 * step(0.2, edge);
            }
            else if (m == DETECTOR)
            {
                solid *= 0.8 + 0.3 * step(0.5, frac((g.x - g.y) * 0.5));
            }
            else if (m == HEATER)
            {
                // Coils.
                solid *= 0.75 + 0.35 * step(0.5, frac(g.y * 0.5));
            }
            else if (m == C4)
            {
                solid *= 0.92 + 0.12 * random01(uint(c.x) * 53u + uint(c.y) * 401u);
            }
            else if (m == COAL || m == FUSE)
            {
                // Coal lumpy, a fuse's cord striped; burning, an orange glow flickering through.
                solid *= m == COAL ? 0.7 + 0.6 * random01(uint(c.x) * 7u + uint(c.y) * 1031u) : 0.8 + 0.3 * step(0.5, frac((g.x + g.y) * 0.5));
                if ((cell & BURNING) != 0)
                {
                    solid = lerp(solid, float3(1.0, 0.45, 0.1), (m == FUSE ? 0.85 : 0.55) + 0.3 * sin(g_C.time * 13.0 + c.x * 2.3 + c.y * 3.7));
                }
            }
            else if (m == BATTERY)
            {
                // A cell, its top a copper band.
                solid = frac(g.y * 0.25) < 0.3 ? float3(0.75, 0.45, 0.2) : solid;
            }
            else if (m == LAMP)
            {
                // Lit: warm white, brighter at the cells' middles.
                const float lit = saturate(float((int(sectionAt(I_SPARK, c.x, c.y)) >> 8) & 0xFF) / 10.0);
                solid = lerp(solid, float3(1.0, 0.92, 0.7) * (0.9 + 0.2 * (1.0 - 2.0 * edge)), lit);
            }
            else if (m == FAN)
            {
                // Stripes moving the way it blows.
                const uint dir = (cell >> 8) & 3u;
                const float along = dir == 0 ? g.x : (dir == 1 ? g.y : (dir == 2 ? -g.x : -g.y));
                solid *= 0.75 + 0.35 * step(0.5, frac(along * 0.5 - g_C.time * 3.0));
            }
            color = solid;
        }
    }

    color += heatColor(t);
    // A spark running through a conductor: blue-white, fading as it rests.
    {
        const int phase = int(sectionAt(I_SPARK, c.x, c.y)) & 0xFF;
        if (phase >= SPARK_LIVE && countAt(NEON, c.x, c.y) == 0)
        {
            color = lerp(color, float3(0.8, 0.92, 1.0), phase <= SPARK_LIVE + 1 ? 0.9 : 0.6 * float(SPARK_LIVE + SPARK_REST + 1 - phase) / float(SPARK_REST));
        }
    }
    // The glow round what's bright.
    color += GLOW_STRENGTH * float3(sampleSection(g, I_GLOW), sampleSection(g, I_GLOW + 1), sampleSection(g, I_GLOW + 2)) / GLOW_SCALE;

    if (g_C.overlay == 1)
    {
        // Pressure, in cells of water depth: blue below zero, then up to red at a third of the grid.
        const float p = sampleFloat(g, F_P) / (g_C.dt * g_C.gravity);
        const float x = saturate(p / (float(g_C.gridH) / 3.0));
        const float3 ramp = p < 0.0 ? float3(0.2, 0.4, 1.0) * saturate(-p / 4.0) : float3(x, 0.25 * (1.0 - abs(2.0 * x - 1.0)) + 0.1 * x, 1.0 - x) * step(0.001, x);
        color = lerp(color * 0.35, ramp, total > 0.5 ? 0.85 : 0.0);
    }
    else if (g_C.overlay == 2)
    {
        color = lerp(color * 0.3, temperatureRamp(sampleFloat(g, F_TCELL)), 0.8);
    }

    // The attraction point: a ring round it, white with a dark rim.
    if (gravityMode() == GRAVITY_POINT)
    {
        const float ring = abs(length(g - float2(g_C.gravityX, g_C.gravityY)) * g_C.cellPixels - 7.0);
        if (ring < 1.0)
        {
            color = lerp(color, float3(1.0, 1.0, 1.0), 0.9);
        }
        else if (ring < 2.5)
        {
            color *= 0.25;
        }
    }

    // The cursor: the edge of the area the brush paints, a white line with a dark rim either side.
    const uint cursorMode = (g_C.brushShape >> 4) & 0xF;
    if (cursorMode == 3)
    {
        // Inspecting: the outline of the cell under the pointer, and a crosshair through it.
        const float2 pointer = float2(g_C.probeX, g_C.probeY);
        const float2 cell = floor(pointer);
        const float2 fromCell = max(cell - g, g - cell - 1.0) * g_C.cellPixels;
        const float outline = abs(max(fromCell.x, fromCell.y));
        const float2 d = abs(g - pointer) * g_C.cellPixels;
        const bool cross = min(d.x, d.y) < 0.75 && max(d.x, d.y) > 6.0 && max(d.x, d.y) < 18.0;
        if (outline < 0.75 || cross)
        {
            color = lerp(color, float3(1.0, 1.0, 1.0), 0.9);
        }
        else if (outline < 2.0)
        {
            color *= 0.25;
        }
    }
    else if (cursorMode != 0)
    {
        const float edge = abs(brushDistance(g, cursorMode, g_C.brushShape & 0xF, float2(g_C.cursorX0, g_C.cursorY0),
            float2(g_C.probeX, g_C.probeY), g_C.brushRadius)) * g_C.cellPixels;
        if (edge < 0.75)
        {
            color = lerp(color, float3(1.0, 1.0, 1.0), 0.9);
        }
        else if (edge < 2.0)
        {
            color *= 0.25;
        }
    }
    return float4(color, 1.0);
}

#endif // !SIMULATION

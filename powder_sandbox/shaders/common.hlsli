// What the simulation and the display share: the root constants, the materials and their
// constants, the grid's sections, a particle, and the small helpers both use.
// (Included by powder_sandbox.hlsl, after the files before it there.)

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
// The cell's FLIP particles (flipCount's), counted once by p2g_cs: summed from their twelve types'
// counts each time, as fluidCell did 8 times a velocity sample, it cost the S23 about 20 ms a step.
#define I_FLIP (I_TSUM + 9)
#define INT_SECTIONS (I_TSUM + 10)
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

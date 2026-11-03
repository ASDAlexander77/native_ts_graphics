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
    // pointer; 3 the cell under the pointer, inspected.
    uint brushShape;

    float cursorX0;
    float cursorY0;
    float pad3;
    float pad4;
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
#define WALL 16
#define GLASS 17
#define WOOD 18
#define URANIUM 19
#define EMITTER 20
#define ICE 21
#define STONE 22
// Tools that aren't materials.
#define ERASE 32
#define HEAT 33
#define COOL 34

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

// gridInt sections: the P2G sums (fixed point), the particle counts per material, the temperature sums,
// the fissions.
#define I_USUM 0
#define I_UW 1
#define I_UM 2
#define I_VSUM 3
#define I_VW 4
#define I_VM 5
#define I_COUNT 6 // + material - 1, for WATER .. LAVA
#define I_TSUM 14
#define I_TCOUNT 15
#define I_FISSION 16
#define INT_SECTIONS 17

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

// u_Alloc: the free particle slots' count, the HUD's probe, then the free slots.
#define A_FREE 0
#define A_PROBE 1
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

bool isSolidMaterial(uint m)
{
    return m >= WALL;
}

bool isFlipMaterial(uint m)
{
    return (m >= WATER && m <= SAND) || m == LAVA;
}

bool isGasMaterial(uint m)
{
    return m >= FIRE && m <= STEAM;
}

float density(uint m)
{
    return m == OIL ? 0.8 : (m == SAND ? 2.0 : (m == LAVA ? 2.6 : 1.0));
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
    return u_GridInt[gi(I_COUNT + material - 1, cellIndex(x, y))];
}

int flipCount(int x, int y)
{
    return countOf(WATER, x, y) + countOf(OIL, x, y) + countOf(SAND, x, y) + countOf(LAVA, x, y);
}

bool fluidCell(int x, int y)
{
    return inGrid(x, y) && !solidCell(x, y) && flipCount(x, y) > 0;
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
    if (t >= g_C.stride)
    {
        return;
    }
    for (uint s = 0; s < F_TPRE; s++)
    {
        u_GridFloat[gi(s, t)] = 0.0;
    }
    u_GridFloat[gi(F_TPRE, t)] = AMBIENT;
    u_GridFloat[gi(F_TSRC, t)] = AMBIENT;
    u_GridFloat[gi(F_TCELL, t)] = AMBIENT;
    u_GridFloat[gi(F_LIFE, t)] = 0.0;
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
    if (t >= g_C.stride)
    {
        return;
    }
    for (uint s = 0; s < F_TPRE; s++)
    {
        u_GridFloat[gi(s, t)] = 0.0;
    }
    u_GridFloat[gi(F_TPRE, t)] = AMBIENT;
    u_GridFloat[gi(F_TSRC, t)] = AMBIENT;
    u_GridFloat[gi(F_TCELL, t)] = AMBIENT;
    u_GridFloat[gi(F_LIFE, t)] = 0.0;
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
}

void splat(uint sumSection, uint weightSection, uint massSection, uint index, float w, float vel, float rho)
{
    InterlockedAdd(u_GridInt[gi(sumSection, index)], int(round(w * vel * VEL_SCALE)));
    InterlockedAdd(u_GridInt[gi(weightSection, index)], int(round(w * WEIGHT_SCALE)));
    InterlockedAdd(u_GridInt[gi(massSection, index)], int(round(w * rho * WEIGHT_SCALE)));
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
    InterlockedAdd(u_GridInt[gi(I_COUNT + p.type - 1, c)], 1);
    if (p.type != NEUTRON)
    {
        InterlockedAdd(u_GridInt[gi(I_TSUM, c)], int(round(p.temp * TEMP_SCALE)));
        InterlockedAdd(u_GridInt[gi(I_TCOUNT, c)], 1);
    }
    if (!isFlipMaterial(p.type))
    {
        return;
    }
    const float rho = density(p.type);

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
        u_GridFloat[gi(F_U, t)] = vel;
        u_GridFloat[gi(F_UOLD, t)] = vel;
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
            vel += g_C.gravity * g_C.dt;
        }
        u_GridFloat[gi(F_V, t)] = solid ? 0.0 : vel;
        u_GridFloat[gi(F_VA, t)] = 1.0 / max(rho, 0.1);
    }
}

// How fast heat crosses a cell's faces, per step (at most 0.25 for the explicit diffusion to stay
// stable with 4 faces).
float conductivity(int x, int y)
{
    const uint m = cellMaterial(x, y);
    if (m == WALL || m == EMITTER)
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
    if (m == WOOD)
    {
        return 0.25;
    }
    if (m == URANIUM)
    {
        return 0.8;
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
    const int2 offsets[4] = { int2(1, 0), int2(-1, 0), int2(0, 1), int2(0, -1) };
    for (int i = 0; i < 4; i++)
    {
        const int nx = x + offsets[i].x;
        const int ny = y + offsets[i].y;
        if (inGrid(nx, ny))
        {
            flow += min(k, conductivity(nx, ny)) * 0.25 * (gf(F_TSRC, cellIndex(nx, ny)) - t);
        }
    }
    float next = t + flow;
    const uint cell = u_Cells[c];

    // Ice and stone hold at their melting point while the heat above it melts them.
    const uint m = cell & 0xFF;
    if (m == ICE || m == STONE)
    {
        const float meltAt = m == ICE ? 0.0 : MELT_STONE;
        if (next > meltAt)
        {
            const float taken = gf(F_LIFE, c) + (next - meltAt);
            next = meltAt;
            u_GridFloat[gi(F_LIFE, c)] = taken;
            if (taken >= (m == ICE ? LATENT_ICE : LATENT_STONE))
            {
                u_Cells[c] = EMPTY | MELTED | (m << 8);
            }
        }
    }
    u_GridFloat[gi(F_TCELL, c)] = next;

    if (m == WOOD)
    {
        if ((cell & BURNING) == 0)
        {
            // Hot enough, or a flame touching it.
            bool touched = false;
            for (int k = 0; k < 4; k++)
            {
                touched = touched || countOf(FIRE, x + offsets[k].x, y + offsets[k].y) > 0;
            }
            if (next > 280.0 || touched)
            {
                u_Cells[c] = cell | BURNING;
                u_GridFloat[gi(F_LIFE, c)] = 3.0 + 2.0 * random01(seedOf(c, 1));
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
    const int2 offsets[4] = { int2(1, 0), int2(-1, 0), int2(0, 1), int2(0, -1) };
    for (int i = 0; i < 4; i++)
    {
        const int nx = x + offsets[i].x;
        const int ny = y + offsets[i].y;
        interior = interior && (solidCell(nx, ny) || flipCount(nx, ny) > 0);
    }
    float excess = clamp(float(flipCount(x, y)) / REST_COUNT - 1.0, -1.0, 2.0);
    if (!interior)
    {
        excess = max(excess, 0.0);
    }
    div -= excess / (16.0 * g_C.dt);
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

RWStructuredBuffer<float> u_Multigrid : register(u5);

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
    l.base = 0;
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
    return solidCell(x, y) || countOf(SAND, x, y) >= packed;
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
    const int cx = clamp(int(floor(p.pos.x)), 0, w - 1);
    const int cy = clamp(int(floor(p.pos.y)), 0, h - 1);
    const uint c = cellIndex(cx, cy);

    if (p.type != NEUTRON)
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
        if (p.type == SAND)
        {
            p.vel = grid;
            // Resting on something: slide down a free diagonal, else hold (static friction).
            // (the pressure keeping a pile from compressing nudges it up a little: still resting)
            if (sandBlocked(cx, cy + 1, 1) && p.vel.y > -20.0)
            {
                // (an empty diagonal: a steeper slope than 45 degrees)
                const bool freeLeft = !sandBlocked(cx - 1, cy + 1, 1) && !solidCell(cx - 1, cy);
                const bool freeRight = !sandBlocked(cx + 1, cy + 1, 1) && !solidCell(cx + 1, cy);
                if (freeLeft || freeRight)
                {
                    float side = freeLeft ? -1.0 : 1.0;
                    if (freeLeft && freeRight)
                    {
                        side = random01(seedOf(index, 2)) < 0.5 ? -1.0 : 1.0;
                    }
                    p.vel.x = lerp(p.vel.x, side * 12.0, 0.3);
                }
                else
                {
                    // Held by static friction: the pressure that levels liquids doesn't spread a pile.
                    p.vel.x = 0.0;
                }
            }
            moveParticle(p.pos, p.vel, p.vel * dt);
        }
        else
        {
            const float2 old = sampleVelocity(p.pos, true);
            p.vel = lerp(grid, p.vel + (grid - old), g_C.flip);
            if (p.type == LAVA)
            {
                // Thick: its sideways flow damped, less the hotter it is (it still falls freely).
                const float rate = lerp(12.0, 3.0, saturate((p.temp - SOLIDIFY_LAVA) / 500.0));
                p.vel.x *= saturate(1.0 - rate * dt);
            }
            // RK2 through the grid's velocity, plus the drift of a lighter or heavier particle
            // through the mixture around it (oil rising out of water): its buoyancy over a relaxation
            // time.
            const float2 mid = p.pos + 0.5 * dt * grid;
            const float mixture = 4.0 / (gf(F_UA, uIndex(cx, cy)) + gf(F_UA, uIndex(cx + 1, cy)) + gf(F_VA, vIndex(cx, cy))
                + gf(F_VA, vIndex(cx, cy + 1)));
            const float drift = (density(p.type) - mixture) / mixture * g_C.gravity * 0.08;
            moveParticle(p.pos, p.vel, (sampleVelocity(mid, false) + float2(0.0, drift)) * dt);
        }
    }
    else if (isGasMaterial(p.type))
    {
        float buoyancy = p.type == FIRE ? 260.0 : (p.type == SMOKE ? 50.0 : 140.0);
        float jitter = p.type == FIRE ? 400.0 : (p.type == SMOKE ? 150.0 : 200.0);
        p.vel.y -= buoyancy * dt;
        p.vel.x += (random01(seedOf(index, 3)) - 0.5) * jitter * dt;
        p.vel *= 0.97;
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

    // What the temperature does.
    if (p.type == WATER && p.temp >= 100.0)
    {
        p.type = STEAM;
        p.vel.y -= 20.0;
    }
    else if (p.type == STEAM && p.temp < 90.0)
    {
        p.type = WATER;
    }
    else if (p.type == OIL && p.temp >= 250.0)
    {
        p.type = FIRE;
        p.life = 1.5 + random01(seedOf(index, 5));
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
        }
        else if (p.life <= 0.0)
        {
            if (random01(seedOf(index, 6)) < 0.35)
            {
                p.type = SMOKE;
                p.life = 2.0 + 2.0 * random01(seedOf(index, 7));
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

    // Stuck in a solid (one painted over it): gone.
    if (p.type != NEUTRON && solidAt(p.pos))
    {
        kill = true;
    }
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

float2 randomDirection(uint seed)
{
    const float a = 6.2831853 * random01(seed);
    return float2(cos(a), sin(a));
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
        if (isFlipMaterial(tool))
        {
            if (!isSolidMaterial(m))
            {
                const float temp = tool == LAVA ? LAVA_TEMP : AMBIENT;
                // An empty cell takes its new particles' temperature now, not at the next step's
                // heat_source_cs (before that the cell rules would see lava at the air's).
                if (flipCount(x, y) == 0)
                {
                    u_GridFloat[gi(F_TCELL, c)] = temp;
                }
                for (int k = flipCount(x, y); k < int(REST_COUNT); k++)
                {
                    spawn(tool, randomInCell(x, y, seedOf(c, 10 + k * 2)), float2(0, 0), temp, 0.0, 0, 0);
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
        else if (isSolidMaterial(tool) && tool < ERASE)
        {
            // (the tools from ERASE on paint no material: Heat and Cool act in heat_source_cs)
            const uint painted = tool | (tool == EMITTER ? g_C.emitType << 8 : 0);
            if (m != tool)
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
        // Melted ice or stone: a cell full of water or lava.
        const bool ice = ((cell >> 8) & 0xFF) == ICE;
        for (int k = 0; k < int(REST_COUNT); k++)
        {
            spawn(ice ? WATER : LAVA, randomInCell(x, y, seedOf(c, 70 + k * 2)), float2(0, 0), ice ? 0.5 : MELT_STONE, 0.0, 0, 0);
        }
        u_Cells[c] = EMPTY;
        u_GridFloat[gi(F_LIFE, c)] = 0.0;
        return;
    }
    if (m == EMPTY)
    {
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

    if (m == EMITTER)
    {
        const uint emitted = (cell >> 8) & 0xFF;
        const int2 offsets[4] = { int2(0, 1), int2(1, 0), int2(-1, 0), int2(0, -1) };
        for (int i = 0; i < 4; i++)
        {
            const int nx = x + offsets[i].x;
            const int ny = y + offsets[i].y;
            if (solidCell(nx, ny))
            {
                continue;
            }
            const uint seed = seedOf(c, 30 + i * 3);
            if (isFlipMaterial(emitted))
            {
                if (flipCount(nx, ny) < 2 && random01(seed) < 0.5)
                {
                    spawn(emitted, randomInCell(nx, ny, seed + 1), float2(offsets[i]) * 10.0, emitted == LAVA ? LAVA_TEMP : AMBIENT, 0.0, 0, 0);
                }
            }
            else if (emitted == FIRE && random01(seed) < 0.25)
            {
                spawn(FIRE, randomInCell(nx, ny, seed + 1), float2(0, 0), 800.0, 1.0 + random01(seed + 2), 0, reserve);
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
    else if (m == WOOD && (cell & BURNING) != 0)
    {
        if (!solidCell(x, y - 1) && random01(seedOf(c, 60)) < 0.2)
        {
            spawn(FIRE, randomInCell(x, y - 1, seedOf(c, 61)), float2(0, 0), 800.0, 0.6 + 0.6 * random01(seedOf(c, 63)), 0, reserve);
        }
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
    for (uint m = WATER; m <= LAVA; m++)
    {
        u_Alloc[A_PROBE + 2 + m] = countOf(m, x, y);
    }
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

int countAt(uint material, int x, int y)
{
    x = clamp(x, 0, int(g_C.gridW) - 1);
    y = clamp(y, 0, int(g_C.gridH) - 1);
    return t_GridInt[(I_COUNT + material - 1) * g_C.stride + cellIndex(x, y)];
}

// A material's particle count, bilinearly between the cell centers.
float sampleCount(float2 g, uint material)
{
    const float2 q = g - 0.5;
    const int2 i0 = int2(floor(q));
    const float2 f = q - float2(i0);
    return lerp(lerp(countAt(material, i0.x, i0.y), countAt(material, i0.x + 1, i0.y), f.x),
        lerp(countAt(material, i0.x, i0.y + 1), countAt(material, i0.x + 1, i0.y + 1), f.x), f.y);
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
    case WALL: return float3(0.42, 0.42, 0.45);
    case GLASS: return float3(0.6, 0.85, 0.92);
    case WOOD: return float3(0.45, 0.28, 0.12);
    case URANIUM: return float3(0.25, 0.65, 0.2);
    case EMITTER: return float3(0.62, 0.22, 0.62);
    case ICE: return float3(0.75, 0.92, 1.0);
    case STONE: return float3(0.33, 0.3, 0.29);
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

float4 display_ps(float4 position : SV_Position) : SV_Target
{
    const float2 g = (position.xy - float2(g_C.viewX, g_C.viewY)) / g_C.cellPixels;
    if (any(g < 0.0) || g.x >= float(g_C.gridW) || g.y >= float(g_C.gridH))
    {
        return float4(0.02, 0.02, 0.03, 1.0);
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
    const float total = water + oil + sand + lava;
    if (total > 0.01)
    {
        float3 liquid = (water * materialColor(WATER) + oil * materialColor(OIL) + sand * materialColor(SAND)
            + lava * materialColor(LAVA)) / total;
        if (sand > water + oil + lava)
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
    const float flicker = 0.8 + 0.2 * sin(g_C.time * 23.0 + g.x * 1.7 + g.y * 2.3);
    color += materialColor(FIRE) * saturate(fire * 0.6) * flicker + float3(1.0, 0.85, 0.4) * saturate(fire * 0.25 - 0.3);

    if (countAt(NEUTRON, c.x, c.y) > 0 && length(frac(g) - 0.5) < 0.35)
    {
        color = lerp(color, materialColor(NEUTRON), 0.85);
    }

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
            else if (m == STONE)
            {
                solid *= 0.8 + 0.3 * random01(uint(c.x) * 131u + uint(c.y) * 977u);
            }
            else if (m == EMITTER)
            {
                solid = length(f - 0.5) < 0.22 ? materialColor((cell >> 8) & 0xFF) : solid;
            }
            color = solid;
        }
    }

    color += heatColor(t);

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

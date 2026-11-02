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

    // The brush: tool, mode (0 none, 1 a capsule of brushRadius from (x0, y0) to (x1, y1), 2 the
    // rectangle between them), in cells.
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
    // probe_cs: the cell read back for the HUD.
    float probeX;
    float probeY;
    uint pad0;

    float pad1;
    float pad2;
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
#define WALL 16
#define GLASS 17
#define WOOD 18
#define URANIUM 19
#define EMITTER 20
// Tools that aren't materials.
#define ERASE 32
#define HEAT 33
#define COOL 34

// A cell: material in bits 0-7, an emitter's material in 8-15, BURNING (wood).
#define BURNING 0x10000

// gridInt sections: the P2G sums (fixed point), the particle counts per material, the temperature sums,
// the fissions.
#define I_USUM 0
#define I_UW 1
#define I_UM 2
#define I_VSUM 3
#define I_VW 4
#define I_VM 5
#define I_COUNT 6 // + material - 1, for WATER .. NEUTRON
#define I_TSUM 13
#define I_TCOUNT 14
#define I_FISSION 15

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
// a burning cell's remaining seconds
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
    return m >= WATER && m <= SAND;
}

bool isGasMaterial(uint m)
{
    return m >= FIRE && m <= STEAM;
}

float density(uint m)
{
    return m == OIL ? 0.8 : (m == SAND ? 2.0 : 1.0);
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

// The distance from p to the brush (0 inside the rectangle in mode 2), in cells.
bool insideBrush(float2 p)
{
    const float2 a = float2(g_C.brushX0, g_C.brushY0);
    const float2 b = float2(g_C.brushX1, g_C.brushY1);
    if (g_C.brushMode == 2)
    {
        return all(p >= min(a, b)) && all(p <= max(a, b));
    }
    const float2 ab = b - a;
    const float t = saturate(dot(p - a, ab) / max(dot(ab, ab), 1e-6));
    return length(p - (a + t * ab)) <= g_C.brushRadius;
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
    return countOf(WATER, x, y) + countOf(OIL, x, y) + countOf(SAND, x, y);
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
    u_Particles[index] = p;
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
    u_Particles[t] = p;
    u_Alloc[A_LIST + t] = int(g_C.capacity - 1 - t);
    if (t == 0)
    {
        u_Alloc[A_FREE] = int(g_C.capacity);
    }
}

// --- A step ---

[numthreads(256, 1, 1)]
void clear_cs(uint3 id : SV_DispatchThreadID)
{
    if (id.x < g_C.stride * 16)
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
    const Particle p = u_Particles[id.x];
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
    if (m == GLASS)
    {
        return 0.5;
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
    return 0.08;
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
    const float next = t + flow;
    u_GridFloat[gi(F_TCELL, c)] = next;

    const uint cell = u_Cells[c];
    if ((cell & 0xFF) == WOOD)
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
    Particle p = u_Particles[index];
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
        p.temp += gf(F_TCELL, c) - gf(F_TPRE, c);
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
        u_Particles[index] = p;
        freeParticle(index);
        return;
    }
    p.pos = clamp(p.pos, float2(0.001, 0.001), float2(w - 0.001, h - 0.001));
    u_Particles[index] = p;
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
                for (int k = flipCount(x, y); k < int(REST_COUNT); k++)
                {
                    spawn(tool, randomInCell(x, y, seedOf(c, 10 + k * 2)), float2(0, 0), AMBIENT, 0.0, 0, 0);
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
        else if (isSolidMaterial(tool))
        {
            const uint painted = tool | (tool == EMITTER ? g_C.emitType << 8 : 0);
            if (m != tool)
            {
                u_Cells[c] = painted;
                u_GridFloat[gi(F_TCELL, c)] = AMBIENT;
                u_GridFloat[gi(F_LIFE, c)] = 0.0;
            }
        }
        else if (tool == ERASE)
        {
            u_Cells[c] = EMPTY;
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
                    spawn(emitted, randomInCell(nx, ny, seed + 1), float2(offsets[i]) * 10.0, AMBIENT, 0.0, 0, 0);
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
    for (uint m = WATER; m <= NEUTRON; m++)
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
    case WALL: return float3(0.42, 0.42, 0.45);
    case GLASS: return float3(0.6, 0.85, 0.92);
    case WOOD: return float3(0.45, 0.28, 0.12);
    case URANIUM: return float3(0.25, 0.65, 0.2);
    case EMITTER: return float3(0.62, 0.22, 0.62);
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
    const float total = water + oil + sand;
    if (total > 0.01)
    {
        float3 liquid = (water * materialColor(WATER) + oil * materialColor(OIL) + sand * materialColor(SAND)) / total;
        if (sand > water + oil)
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
    return float4(color, 1.0);
}

#endif // !SIMULATION

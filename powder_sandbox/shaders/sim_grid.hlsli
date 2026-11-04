// The simulation's buffers (u0 .. u5), a cell's and a face's accessors, gravity, the gases'
// and electricity's neighborhood tests, and particles allocated, freed and spawned.
// (Included by powder_sandbox.hlsl, after the files before it there.)

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
    return inGrid(x, y) ? u_GridInt[gi(I_FLIP, cellIndex(x, y))] : 0;
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

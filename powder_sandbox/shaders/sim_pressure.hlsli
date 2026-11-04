// The pressure solve: the divergence, red-black SOR (pressure_cs) and the multigrid's V-cycles
// (mg_*_cs).
// (Included by powder_sandbox.hlsl, after the files before it there.)

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

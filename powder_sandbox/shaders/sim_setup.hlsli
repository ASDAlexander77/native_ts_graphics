// Setup (the grid's cells, scene and particles) and the regrid (the grid made again in another
// shape, a phone turned).
// (Included by powder_sandbox.hlsl, after the files before it there.)

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

// Heat: its sources (heat_source_cs) and its diffusion (heat_diffuse_cs).
// (Included by powder_sandbox.hlsl, after the files before it there.)

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

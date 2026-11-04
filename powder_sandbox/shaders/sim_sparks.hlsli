// Electricity: sparks along conductors, batteries, lamps and switches (spark_cs).
// (Included by powder_sandbox.hlsl, after the files before it there.)

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

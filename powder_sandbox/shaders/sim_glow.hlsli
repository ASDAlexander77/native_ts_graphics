// Glow: the light hot and burning cells give off, blurred (glow_emit_cs, glow_x_cs, glow_y_cs).
// (Included by powder_sandbox.hlsl, after the files before it there.)

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

// The air: a coarse grid of wind, driven by fans, fire and blasts (air_cs).
// (Included by powder_sandbox.hlsl, after the files before it there.)

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

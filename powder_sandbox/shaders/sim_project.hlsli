// The pressure's gradient off the faces (project_cs), and the particles' velocity sampled and
// their moves against the solids.
// (Included by powder_sandbox.hlsl, after the files before it there.)

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
    return solidCell(x, y) || countOf(SAND, x, y) + countOf(SALT, x, y) + countOf(GUNPOWDER, x, y) >= packed;
}

// The mean salinity of a cell's water (0 with none).

// Acid eats this solid cell (not glass, nor the wall around the grid).
bool eatable(int x, int y)
{
    if (x <= 0 || y <= 0 || x >= int(g_C.gridW) - 1 || y >= int(g_C.gridH) - 1)
    {
        return false;
    }
    const uint m = cellMaterial(x, y);
    return isSolidMaterial(m) && m != GLASS;
}

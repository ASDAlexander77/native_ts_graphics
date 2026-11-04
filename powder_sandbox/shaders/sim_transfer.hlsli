// A step, the particles to the grid: cleared, splatted (p2g_cs) and the grid's velocities and
// temperatures made of them (grid_cs).
// (Included by powder_sandbox.hlsl, after the files before it there.)

// --- A step ---

[numthreads(256, 1, 1)]
void clear_cs(uint3 id : SV_DispatchThreadID)
{
    if (id.x < g_C.stride * INT_SECTIONS)
    {
        u_GridInt[id.x] = 0;
    }
    if (id.x == 0 && g_C.substep == 0)
    {
        u_Alloc[A_VISCOUS] = 0;
    }
}

void splat(uint sumSection, uint weightSection, uint massSection, uint index, float w, float vel, float rho)
{
    InterlockedAdd(u_GridInt[gi(sumSection, index)], int(round(w * vel * VEL_SCALE)));
    InterlockedAdd(u_GridInt[gi(weightSection, index)], int(round(w * WEIGHT_SCALE)));
    InterlockedAdd(u_GridInt[gi(massSection, index)], int(round(w * rho * WEIGHT_SCALE)));
}

// A particle's viscosity (lava's falls as it heats up).
float viscosity(Particle p)
{
    if (p.type == HONEY)
    {
        return HONEY_VISCOSITY;
    }
    if (p.type == LAVA)
    {
        return lerp(LAVA_VISCOSITY_COLD, LAVA_VISCOSITY_HOT, saturate((p.temp - SOLIDIFY_LAVA) / (LAVA_TEMP - SOLIDIFY_LAVA)));
    }
    return 0.0;
}

void splatViscosity(uint section, uint index, float w, float nu)
{
    InterlockedAdd(u_GridInt[gi(section, index)], int(round(w * nu)));
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
    InterlockedAdd(u_GridInt[gi(countSection(p.type), c)], 1);
    // (an ember's heat is only shown: it lights nothing)
    if (p.type != NEUTRON && p.type != EMBER)
    {
        InterlockedAdd(u_GridInt[gi(I_TSUM, c)], int(round(p.temp * TEMP_SCALE)));
        InterlockedAdd(u_GridInt[gi(I_TCOUNT, c)], 1);
    }
    if (p.type == WATER && p.life > 0.0)
    {
        InterlockedAdd(u_GridInt[gi(I_SALT, c)], int(round(p.life * SALT_SCALE)));
    }
    // (gunpowder and nitroglycerin going off, petrol and hydrogen lit: some grains' whoosh)
    const int blast = (p.type == GUNPOWDER && p.temp >= IGNITE_GUNPOWDER) ? 1 : ((p.type == NITRO && p.temp >= IGNITE_NITRO) ? NITRO_BLAST
        : (((p.type == PETROL && p.temp >= IGNITE_PETROL && id.x % PETROL_WHOOSH == 0)
        || (p.type == HYDROGEN && p.temp >= IGNITE_GAS && id.x % HYDROGEN_WHOOSH == 0)) ? 1 : 0));
    if (blast > 0)
    {
        InterlockedAdd(u_GridInt[gi(I_BLAST, c)], blast);
    }
    if (!isFlipMaterial(p.type))
    {
        return;
    }
    InterlockedAdd(u_GridInt[gi(I_FLIP, c)], 1);
    const float rho = particleDensity(p);
    const float nu = viscosity(p);
    if (!isPowder(p.type))
    {
        InterlockedAdd(u_GridInt[gi(I_LIQUID, c)], 1);
    }
    if (nu > 0.0 && u_Alloc[A_VISCOUS] == 0)
    {
        InterlockedOr(u_Alloc[A_VISCOUS], 1);
    }

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
        if (nu > 0.0)
        {
            splatViscosity(I_UVISC, uIndex(i0, j0), (1 - tx) * (1 - ty), nu);
            splatViscosity(I_UVISC, uIndex(i0 + 1, j0), tx * (1 - ty), nu);
            splatViscosity(I_UVISC, uIndex(i0, j0 + 1), (1 - tx) * ty, nu);
            splatViscosity(I_UVISC, uIndex(i0 + 1, j0 + 1), tx * ty, nu);
        }
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
        if (nu > 0.0)
        {
            splatViscosity(I_VVISC, vIndex(i0, j0), (1 - tx) * (1 - ty), nu);
            splatViscosity(I_VVISC, vIndex(i0 + 1, j0), tx * (1 - ty), nu);
            splatViscosity(I_VVISC, vIndex(i0, j0 + 1), (1 - tx) * ty, nu);
            splatViscosity(I_VVISC, vIndex(i0 + 1, j0 + 1), tx * ty, nu);
        }
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
        u_GridFloat[gi(F_UOLD, t)] = vel;
        if (weight > 0 && !(solidCell(i - 1, j) || solidCell(i, j)))
        {
            vel += gravityAt(float2(i, j + 0.5)).x * g_C.dt;
        }
        u_GridFloat[gi(F_U, t)] = vel;
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
            vel += gravityAt(float2(i + 0.5, j)).y * g_C.dt;
        }
        u_GridFloat[gi(F_V, t)] = solid ? 0.0 : vel;
        u_GridFloat[gi(F_VA, t)] = 1.0 / max(rho, 0.1);
    }
}

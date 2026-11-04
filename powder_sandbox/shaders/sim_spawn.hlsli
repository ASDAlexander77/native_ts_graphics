// The cells' own reactions and the particles they make (spawn_cs): emitters, uranium, burning
// solids, melting and freezing, the brush painting.
// (Included by powder_sandbox.hlsl, after the files before it there.)

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
        if (isFlipMaterial(tool) || tool == SALT_WATER)
        {
            if (!isSolidMaterial(m))
            {
                const float temp = tool == LAVA ? LAVA_TEMP : AMBIENT;
                const uint type = tool == SALT_WATER ? WATER : tool;
                const float salinity = tool == SALT_WATER ? 1.0 : 0.0;
                // An empty cell takes its new particles' temperature now, not at the next step's
                // heat_source_cs (before that the cell rules would see lava at the air's).
                if (flipCount(x, y) == 0)
                {
                    u_GridFloat[gi(F_TCELL, c)] = temp;
                }
                for (int k = flipCount(x, y); k < int(REST_COUNT); k++)
                {
                    spawn(type, randomInCell(x, y, seedOf(c, 10 + k * 2)), float2(0, 0), temp, salinity, 0, 0);
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
        else if (isGasMaterial(tool))
        {
            // (hydrogen, oxygen, neon: up to two a cell)
            if (!isSolidMaterial(m) && countOf(tool, x, y) < 2 && random01(seedOf(c, 20)) < 0.5)
            {
                spawn(tool, randomInCell(x, y, seedOf(c, 21)), float2(0, 0), AMBIENT, 0.0, 0, reserve);
            }
        }
        else if (isSolidMaterial(tool) && (tool < ERASE || tool >= FIRST_SOLID_AFTER_TOOLS) && tool != BLOCK)
        {
            // (the tools from ERASE on paint no material: Heat and Cool act in heat_source_cs)
            const uint painted = tool | (tool == EMITTER || tool == FAN ? g_C.emitType << 8 : 0);
            // (a fan painted over again takes the new direction)
            if (m != tool || (tool == FAN && u_Cells[c] != painted))
            {
                u_Cells[c] = painted;
                u_GridFloat[gi(F_TCELL, c)] = tool == ICE ? ICE_TEMP : AMBIENT;
                u_GridFloat[gi(F_LIFE, c)] = 0.0;
            }
        }
        else if (tool == ERASE)
        {
            u_Cells[c] = EMPTY;
        }
        return;
    }

    if ((cell & MELTED) != 0)
    {
        // Melted ice, stone or metal: a cell full of water or lava. C-4 gone off: gunpowder going off.
        const uint was = (cell >> 8) & 0xFF;
        if (was == C4)
        {
            for (int k = 0; k < C4_GRAINS; k++)
            {
                spawn(GUNPOWDER, randomInCell(x, y, seedOf(c, 70 + k * 2)), float2(0, 0), IGNITE_GUNPOWDER, 0.0, 0, 0);
            }
        }
        else
        {
            for (int k = 0; k < int(REST_COUNT); k++)
            {
                spawn(was == ICE ? WATER : LAVA, randomInCell(x, y, seedOf(c, 70 + k * 2)), float2(0, 0),
                    was == ICE ? 0.5 : (was == METAL ? MELT_METAL : MELT_STONE), 0.0, 0, 0);
            }
        }
        u_Cells[c] = EMPTY;
        u_GridFloat[gi(F_LIFE, c)] = 0.0;
        return;
    }
    if (m == EMPTY)
    {
        // Embers off fire, and off lava's surface (with nothing above it, against the gravity).
        const float dt = g_C.dt;
        const int fires = min(countOf(FIRE, x, y), 4);
        int2 down;
        if (fires > 0 && random01(seedOf(c, 80)) < EMBER_RATE * float(fires) * dt)
        {
            spawn(EMBER, randomInCell(x, y, seedOf(c, 81)), randomDirection(seedOf(c, 83)) * 40.0, EMBER_TEMP,
                EMBER_LIFE * (0.5 + random01(seedOf(c, 84))), 0, reserve);
        }
        else if (countOf(LAVA, x, y) >= 2 && gravityDown(float2(x, y) + 0.5, down) && flipCount(x - down.x, y - down.y) == 0
            && !solidCell(x - down.x, y - down.y) && random01(seedOf(c, 85)) < LAVA_EMBER_RATE * dt)
        {
            spawn(EMBER, randomInCell(x - down.x, y - down.y, seedOf(c, 86)),
                -float2(down) * 60.0 + randomDirection(seedOf(c, 88)) * 30.0, EMBER_TEMP,
                EMBER_LIFE * (0.5 + random01(seedOf(c, 89))), 0, reserve);
        }

        // Water cold enough freezes, lava cool enough sets (its particles end up inside the solid,
        // and g2p frees them).
        const float t = gf(F_TCELL, c);
        uint solid = EMPTY;
        if (countOf(WATER, x, y) >= 2 && t < FREEZE_WATER)
        {
            solid = ICE;
        }
        else if (countOf(LAVA, x, y) >= 2 && t < SOLIDIFY_LAVA)
        {
            solid = STONE;
        }
        if (solid != EMPTY)
        {
            u_Cells[c] = solid;
            u_GridFloat[gi(F_LIFE, c)] = 0.0;
        }
        return;
    }

    if (m == CLONE && ((cell >> 8) & 0xFF) == 0)
    {
        // Not yet learned: the first particle type beside it (but neutrons and embers).
        uint learned = 0;
        for (int o = 0; o < 4 && learned == 0; o++)
        {
            const int2 s = int2(x, y) + sideOffset(o);
            for (uint k = 0; k < PARTICLE_TYPES && learned == 0; k++)
            {
                const uint t = k < EMBER ? k + 1 : k - EMBER + HYDROGEN;
                learned = t != NEUTRON && t != EMBER && u_GridInt[gi(I_COUNT + k, cellIndex(s.x, s.y))] > 0 ? t : 0;
            }
        }
        if (learned != 0)
        {
            u_Cells[c] = CLONE | (learned << 8);
        }
        return;
    }
    if (m == SPONGE)
    {
        // Its water spreads through it, a particle a step to a drier side; hot, it lets it out, a
        // particle a step, into a side with room. (Atomic: the sides do the same at once.)
        const uint held = (cell >> 8) & 0xFF;
        const int2 s = int2(x, y) + sideOffset(int(hash(seedOf(c, 90)) & 3));
        if (held > 0 && inGrid(s.x, s.y))
        {
            const uint side = u_Cells[cellIndex(s.x, s.y)];
            if ((side & 0xFF) == SPONGE && ((side >> 8) & 0xFF) < held)
            {
                InterlockedAdd(u_Cells[cellIndex(s.x, s.y)], 0x100u);
                InterlockedAdd(u_Cells[c], 0xFFFFFF00u);
            }
            else if (gf(F_TCELL, c) > SPONGE_SQUEEZE && !solidCell(s.x, s.y) && flipCount(s.x, s.y) < int(REST_COUNT))
            {
                spawn(WATER, randomInCell(s.x, s.y, seedOf(c, 91)), float2(0, 0), gf(F_TCELL, c), 0.0, 0, 0);
                InterlockedAdd(u_Cells[c], 0xFFFFFF00u);
            }
        }
        return;
    }
    if (m == PLANT)
    {
        // With energy, now and then a cell grows up (or 45 degrees either side of up), the new one
        // taking the rest of it.
        const uint energy = (cell >> 8) & 0xFF;
        if (energy > 0 && (cell & BURNING) == 0 && random01(seedOf(c, 92)) < GROW_RATE * g_C.dt)
        {
            int2 down;
            int2 up = int2(0, -1);
            if (gravityDown(float2(x, y) + 0.5, down))
            {
                up = -down;
            }
            else
            {
                up = sideOffset(int(hash(seedOf(c, 95)) & 3));
            }
            const float pick = random01(seedOf(c, 93));
            const int2 way = pick < 0.5 ? up : turned45(up, pick < 0.75 ? 1 : -1);
            const int2 s = int2(x, y) + way;
            if (inGrid(s.x, s.y) && cellMaterial(s.x, s.y) == EMPTY && flipCount(s.x, s.y) == 0)
            {
                u_Cells[cellIndex(s.x, s.y)] = PLANT | ((energy - 1) << 8);
                u_Cells[c] = cell & ~0xFF00u;
            }
        }
    }
    if (m == EMITTER || (m == CLONE && ((cell >> 8) & 0xFF) != 0))
    {
        const uint emitted = (cell >> 8) & 0xFF;
        for (int i = 0; i < 4; i++)
        {
            const int nx = x + sideOffset(i).x;
            const int ny = y + sideOffset(i).y;
            if (solidCell(nx, ny))
            {
                continue;
            }
            const uint seed = seedOf(c, 30 + i * 3);
            if (isFlipMaterial(emitted))
            {
                if (flipCount(nx, ny) < 2 && random01(seed) < 0.5)
                {
                    spawn(emitted, randomInCell(nx, ny, seed + 1), float2(sideOffset(i)) * 10.0, emitted == LAVA ? LAVA_TEMP : AMBIENT, 0.0, 0, 0);
                }
            }
            else if (emitted == FIRE && random01(seed) < 0.25)
            {
                spawn(FIRE, randomInCell(nx, ny, seed + 1), float2(0, 0), 800.0, 1.0 + random01(seed + 2), 0, reserve);
            }
            else if (isGasMaterial(emitted) && countOf(emitted, nx, ny) < 2 && random01(seed) < 0.25)
            {
                spawn(emitted, randomInCell(nx, ny, seed + 1), float2(sideOffset(i)) * 10.0, AMBIENT, 0.0, 0, reserve);
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
    else if ((m == WOOD || m == COAL || m == FUSE) && (cell & BURNING) != 0)
    {
        if (!solidCell(x, y - 1) && random01(seedOf(c, 60)) < (m == WOOD ? 0.2 : (m == COAL ? 0.05 : 0.5)))
        {
            spawn(FIRE, randomInCell(x, y - 1, seedOf(c, 61)), float2(0, 0), 800.0, 0.6 + 0.6 * random01(seedOf(c, 63)), 0, reserve);
        }
    }
}

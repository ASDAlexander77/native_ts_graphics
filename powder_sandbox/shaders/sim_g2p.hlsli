// The grid back to the particles (g2p_cs): their velocities, temperatures and moves, and every
// particle's reactions (boiling, burning, dissolving, blasts), with the sound events counted.
// (Included by powder_sandbox.hlsl, after the files before it there.)

// An event of the step counted: the wave's at once (one atomic a wave, not a particle).
void countEvent(uint event, bool happened)
{
    const uint n = WaveActiveCountBits(happened);
    if (n > 0 && WaveIsFirstLane())
    {
        InterlockedAdd(u_GridInt[gi(I_EVENTS, event)], int(n));
    }
}

// Grid to particles: the liquids' and powders' new velocities (FLIP: the grid's change added to
// their own; sand takes the grid's, with friction where it rests), their moves; the gases' buoyancy;
// the neutrons' flight; temperatures and the changes they cause.
[numthreads(256, 1, 1)]
void g2p_cs(uint3 id : SV_DispatchThreadID)
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
    const int w = int(g_C.gridW);
    const int h = int(g_C.gridH);
    const float dt = g_C.dt;
    bool kill = g_C.brushMode != 0 && g_C.tool == ERASE && insideBrush(p.pos);
    // (from the temperature p2g_cs saw, so each grain that went off there blasts once)
    const bool goesOff = (p.type == GUNPOWDER && p.temp >= IGNITE_GUNPOWDER) || (p.type == NITRO && p.temp >= IGNITE_NITRO);
    const bool petrolLit = p.type == PETROL && p.temp >= IGNITE_PETROL;
    const bool hydrogenLit = p.type == HYDROGEN && p.temp >= IGNITE_GAS;
    bool splash = false;
    bool fizz = false;
    const int cx = clamp(int(floor(p.pos.x)), 0, w - 1);
    const int cy = clamp(int(floor(p.pos.y)), 0, h - 1);
    const uint c = cellIndex(cx, cy);

    if (p.type != NEUTRON && p.type != EMBER)
    {
        // The cell's change, then the particles sharing it evening out toward its mean (which the
        // change made F_TCELL, so the heat is kept): water in a cell with lava boils.
        const float cellTemp = gf(F_TCELL, c);
        p.temp += cellTemp - gf(F_TPRE, c);
        if (!solidCell(cx, cy))
        {
            p.temp = lerp(p.temp, cellTemp, saturate(10.0 * dt));
        }
    }

    if (isFlipMaterial(p.type))
    {
        const float2 grid = sampleVelocity(p.pos, false);
        if (isPowder(p.type))
        {
            p.vel = grid;
            // Resting on something (below it, along the gravity): slide down a free diagonal, else
            // hold (static friction). (the pressure keeping a pile from compressing nudges it up a
            // little: still resting)
            int2 down;
            if (gravityDown(p.pos, down) && sandBlocked(cx + down.x, cy + down.y, 1) && dot(p.vel, normalize(float2(down))) > -20.0)
            {
                // (an empty cell 45 degrees either side of down, the one beside it on the way not
                // solid: a steeper slope than 45 degrees)
                const int2 slideA = turned45(down, -1);
                const int2 slideB = turned45(down, 1);
                const int2 besideA = slideA - down;
                const int2 besideB = slideB - down;
                const bool freeA = !sandBlocked(cx + slideA.x, cy + slideA.y, 1) && !solidCell(cx + besideA.x, cy + besideA.y);
                const bool freeB = !sandBlocked(cx + slideB.x, cy + slideB.y, 1) && !solidCell(cx + besideB.x, cy + besideB.y);
                const float2 across = normalize(float2(-down.y, down.x));
                const float sideways = dot(p.vel, across);
                float target = 0.0;
                if (freeA || freeB)
                {
                    float2 way = normalize(float2(freeA ? besideA : besideB));
                    if (freeA && freeB && random01(seedOf(index, 2)) < 0.5)
                    {
                        way = normalize(float2(besideB));
                    }
                    target = lerp(sideways, dot(way, across) * 12.0, 0.3);
                }
                // (else held by static friction: the pressure that levels liquids doesn't spread a pile)
                p.vel += across * (target - sideways);
            }
            // Airborne grains (and a pile's loose top: fewer than a packed cell's): dragged by the air.
            if (float(flipCount(cx, cy)) < REST_COUNT)
            {
                p.vel += (airVelocity(p.pos) - p.vel) * saturate(POWDER_DRAG * dt);
            }
            moveParticle(p.pos, p.vel, p.vel * dt);
        }
        else
        {
            const float2 old = sampleVelocity(p.pos, true);
            splash = length(grid - old) > SPLASH_SPEED;
            // (nitroglycerin jolted: heated to where it goes off, at the next step)
            if (p.type == NITRO && length(grid - old) > NITRO_SHOCK)
            {
                p.temp = max(p.temp, IGNITE_NITRO);
            }
            // (viscous liquids take the grid's velocity, PIC: their own would undo the diffusion)
            p.vel = lerp(grid, p.vel + (grid - old), viscosity(p) > 0.0 ? 0.0 : g_C.flip);
            // RK2 through the grid's velocity, plus the drift of a lighter or heavier particle
            // through the mixture around it (oil rising out of water): its buoyancy over a relaxation
            // time.
            const float2 mid = p.pos + 0.5 * dt * grid;
            const float mixture = 4.0 / (gf(F_UA, uIndex(cx, cy)) + gf(F_UA, uIndex(cx + 1, cy)) + gf(F_VA, vIndex(cx, cy))
                + gf(F_VA, vIndex(cx, cy + 1)));
            const float2 drift = (particleDensity(p) - mixture) / mixture * gravityAt(p.pos) * 0.08;
            // Surface tension: a pull on its velocity, not its position (a positional drift carries no
            // momentum: it held small drops up in the air, gravity never getting a fall going).
            p.vel += cohesion(cx, cy) * dt;
            moveParticle(p.pos, p.vel, (sampleVelocity(mid, false) + drift) * dt);
        }
    }
    else if (isGasMaterial(p.type))
    {
        // Lift against the gravity, from its heat; pushed from where gas is more crowded; wandering;
        // carried by the air; cooling (fire stays hot while it burns).
        p.vel -= gravityAt(p.pos) * gasLift(p.type, p.temp) * dt;
        const int n = gasCount(cx, cy);
        float2 crowd = float2(0.0, 0.0);
        for (int o = 0; o < 4; o++)
        {
            const int2 s = int2(cx, cy) + sideOffset(o);
            if (inGrid(s.x, s.y) && !solidCell(s.x, s.y))
            {
                crowd += float2(sideOffset(o)) * float(gasCount(s.x, s.y) - n);
            }
        }
        p.vel -= GAS_SPREAD * 0.5 * crowd * dt;
        const float jitter = p.type == FIRE ? 400.0 : (p.type == SMOKE ? 150.0 : 200.0);
        p.vel += (float2(random01(seedOf(index, 3)), random01(seedOf(index, 17))) - 0.5) * jitter * dt;
        p.vel = lerp(p.vel, airVelocity(p.pos), GAS_DRAG);
        if (p.type != FIRE)
        {
            p.temp = lerp(p.temp, AMBIENT, saturate(GAS_COOLING * dt));
        }
        moveParticle(p.pos, p.vel, p.vel * dt);
    }
    else if (p.type == EMBER)
    {
        // An ember: dragged along by the air (up a plume), falling a little, wandering, cooling; out
        // in water, or once cool.
        p.vel += gravityAt(p.pos) * EMBER_WEIGHT * dt;
        p.vel = lerp(p.vel, airVelocity(p.pos), saturate(EMBER_DRAG * dt));
        p.vel += (float2(random01(seedOf(index, 18)), random01(seedOf(index, 19))) - 0.5) * 300.0 * dt;
        p.temp = lerp(p.temp, AMBIENT, saturate(EMBER_COOLING * dt));
        p.life -= dt;
        kill = kill || p.life <= 0.0 || countOf(WATER, cx, cy) > 0;
        moveParticle(p.pos, p.vel, p.vel * dt);
    }
    else
    {
        // A neutron: straight on. Walls absorb it, uranium splits (outside its birth cell), water
        // slows and sometimes absorbs it.
        p.pos += p.vel * dt;
        const int nx = int(floor(p.pos.x));
        const int ny = int(floor(p.pos.y));
        if (!inGrid(nx, ny))
        {
            kill = true;
        }
        else
        {
            const uint n = cellIndex(nx, ny);
            const uint m = cellMaterial(nx, ny);
            if (m == WALL)
            {
                kill = true;
            }
            else if (m == URANIUM)
            {
                if (n != p.origin)
                {
                    InterlockedAdd(u_GridInt[gi(I_FISSION, n)], 1);
                    kill = true;
                }
            }
            else
            {
                p.origin = 0xFFFFFFFF;
                if (countOf(WATER, nx, ny) >= 2)
                {
                    p.vel *= 0.99;
                    kill = kill || random01(seedOf(index, 4)) < 0.003;
                }
            }
        }
        p.life -= dt;
        kill = kill || p.life <= 0.0;
    }

    // Salt water evens out with the water around it; salt in unsaturated water dissolves.
    if (p.type == WATER)
    {
        p.life = lerp(p.life, cellSalinity(c, cx, cy), saturate(SALT_MIX * dt));
    }
    else if (p.type == SALT && countOf(WATER, cx, cy) >= 2 && cellSalinity(c, cx, cy) < SATURATED
        && random01(seedOf(index, 10)) < DISSOLVE_RATE * dt)
    {
        p.type = WATER;
        p.life = 1.0;
    }
    else if (p.type == ACID && countOf(WATER, cx, cy) >= 1 && random01(seedOf(index, 14)) < DILUTE_RATE * dt)
    {
        p.type = WATER;
        p.life = 0.0;
        p.temp += DILUTE_HEAT;
        fizz = true;
    }

    // A spark in their cell or beside it lights gunpowder, petrol, oil and nitroglycerin (heated to
    // where they do), a flame nitroglycerin too.
    if ((p.type == GUNPOWDER || p.type == PETROL || p.type == OIL || p.type == NITRO) && sparkBeside(cx, cy))
    {
        p.temp = max(p.temp, p.type == GUNPOWDER ? IGNITE_GUNPOWDER : (p.type == PETROL ? IGNITE_PETROL : (p.type == OIL ? IGNITE_OIL : IGNITE_NITRO)));
    }
    if (p.type == NITRO && fireBeside(cx, cy))
    {
        p.temp = max(p.temp, IGNITE_NITRO);
    }
    // Hydrogen and oxygen beside a flame, or hot, catch (not at a spark: the electrode making them
    // would light them as they're made): hydrogen heated to where it lights (it burns at the next
    // step, its whoosh in that step's pressure), oxygen flaring at once.
    if ((p.type == HYDROGEN || p.type == OXYGEN) && !hydrogenLit && (p.temp >= IGNITE_GAS || fireBeside(cx, cy))
        && random01(seedOf(index, 20)) < CATCH_GAS * dt)
    {
        if (p.type == HYDROGEN)
        {
            p.temp = IGNITE_GAS;
        }
        else
        {
            p.type = FIRE;
            p.temp = OXYGEN_FIRE_TEMP;
            p.life = 0.3 + 0.3 * random01(seedOf(index, 23));
        }
    }
    // A current into water splits it now and then, at the electrode (a sparked metal cell beside it):
    // two parts hydrogen to one oxygen.
    if (p.type == WATER && electrodeBeside(cx, cy) && random01(seedOf(index, 21)) < ELECTROLYSIS_RATE)
    {
        p.type = random01(seedOf(index, 22)) < 0.667 ? HYDROGEN : OXYGEN;
        p.life = 0.0;
        fizz = true;
    }

    // Oil and petrol beside fire catch: heated to where they light (below). Only at their surface
    // (open to the air: the fire's heat would light a pool through), oil burning down from it.
    const bool exposed = (p.type == OIL || p.type == PETROL) && airBeside(cx, cy);
    const bool lit = exposed && (p.temp >= (p.type == OIL ? IGNITE_OIL : IGNITE_PETROL) || fireBeside(cx, cy));
    if (p.type == PETROL && !petrolLit && lit && random01(seedOf(index, 15)) < CATCH_PETROL * dt)
    {
        p.temp = max(p.temp, IGNITE_PETROL);
    }

    // What the temperature does. Gunpowder goes off; salt water boiling leaves its salt (as often
    // as it's salty).
    if (goesOff)
    {
        p.type = FIRE;
        p.temp = BLAST_TEMP;
        p.life = 0.4 + 0.4 * random01(seedOf(index, 12));
        p.vel += randomDirection(seedOf(index, 13)) * BLAST_SPEED;
    }
    else if (p.type == WATER && p.temp >= 100.0)
    {
        p.type = random01(seedOf(index, 11)) < p.life ? SALT : STEAM;
        fizz = true;
        p.life = 0.0;
        if (p.type == STEAM)
        {
            p.vel.y -= 20.0;
        }
    }
    else if (p.type == STEAM && p.temp < 90.0)
    {
        p.type = WATER;
    }
    else if (p.type == OIL && lit && random01(seedOf(index, 15)) < CATCH_OIL * dt)
    {
        p.type = FIRE;
        p.life = OIL_BURN + 2.0 * random01(seedOf(index, 5));
    }
    else if (hydrogenLit)
    {
        // (lit last step; it burns into water, as steam: see FIRE)
        p.type = FIRE;
        p.temp = HYDROGEN_FIRE_TEMP;
        p.life = 0.2 + 0.2 * random01(seedOf(index, 24));
        p.origin = HYDROGEN;
        p.vel += randomDirection(seedOf(index, 25)) * 30.0;
    }
    else if (p.type == THERMITE && (p.temp >= IGNITE_THERMITE || fireBeside(cx, cy) || countOf(LAVA, cx, cy) > 0)
        && random01(seedOf(index, 26)) < CATCH_THERMITE * dt)
    {
        // Burning into molten iron.
        p.type = LAVA;
        p.temp = THERMITE_TEMP;
        p.life = THERMITE_BURN * (0.5 + random01(seedOf(index, 29)));
        fizz = true;
    }
    else if (petrolLit)
    {
        // (lit last step, its whoosh in that step's pressure)
        p.type = FIRE;
        p.temp = PETROL_FIRE_TEMP;
        p.life = PETROL_BURN + 0.3 * random01(seedOf(index, 16));
        p.vel.y -= 30.0;
    }
    else if (p.type == FIRE)
    {
        p.temp = max(p.temp, 800.0);
        p.life -= dt;
        const int px = clamp(int(floor(p.pos.x)), 0, w - 1);
        const int py = clamp(int(floor(p.pos.y)), 0, h - 1);
        if (countOf(WATER, px, py) >= 2)
        {
            p.type = STEAM;
            p.temp = 105.0;
            p.life = 0.0;
        }
        else if (p.life <= 0.0)
        {
            if (p.origin == HYDROGEN)
            {
                // Burned hydrogen: water, as steam.
                p.type = STEAM;
                p.temp = 300.0;
                p.life = 0.0;
                p.origin = 0;
            }
            else if (random01(seedOf(index, 6)) < 0.35)
            {
                p.type = SMOKE;
                p.life = SMOKE_LIFE * (1.0 + random01(seedOf(index, 7)));
                p.temp = 300.0;
            }
            else
            {
                kill = true;
            }
        }
    }
    else if (p.type == SMOKE)
    {
        p.life -= dt;
        kill = kill || p.life <= 0.0;
    }

    // Acid: now and then, a solid next to it eaten (an empty cell), the acid used up. The cell is
    // claimed with a compare-exchange: of the acid around it, one takes it.
    if (p.type == ACID && !kill)
    {
        const int2 n = int2(floor(p.pos)) + sideOffset(int(hash(seedOf(index, 8)) & 3));
        if (eatable(n.x, n.y) && random01(seedOf(index, 9)) < ACID_RATE * dt)
        {
            const uint c = cellIndex(n.x, n.y);
            const uint before = u_Cells[c];
            uint original;
            InterlockedCompareExchange(u_Cells[c], before, EMPTY, original);
            kill = original == before;
            fizz = kill;
        }
    }

    if (p.type == LAVA && p.life > 0.0)
    {
        p.life -= dt;
        p.temp = max(p.temp, THERMITE_TEMP);
    }
    if (p.type == LAVA && p.temp >= THERMITE_CUT && !kill)
    {
        const int2 n = int2(floor(p.pos)) + sideOffset(int(hash(seedOf(index, 27)) & 3));
        if (inGrid(n.x, n.y) && cellMaterial(n.x, n.y) == METAL && random01(seedOf(index, 28)) < CUT_RATE * dt)
        {
            const uint c = cellIndex(n.x, n.y);
            const uint before = u_Cells[c];
            uint original;
            // (an open cell, the molten iron sinking into it: melted into lava cooler than the iron, the
            // cell would fill and stop it)
            InterlockedCompareExchange(u_Cells[c], before, EMPTY, original);
            if (original == before)
            {
                p.temp -= CUT_HEAT;
                fizz = true;
            }
        }
    }

    // In a body's cell (one drawn over it): out past its nearest edge, at its velocity.
    const uint inBody = cellBody(int(floor(p.pos.x)), int(floor(p.pos.y)));
    if (p.type != NEUTRON && inBody < MAX_BODIES)
    {
        const Body body = loadBody(inBody);
        float2 l = bodyLocal(body, p.pos);
        const float2 depth = body.half - abs(l);
        if (depth.x < depth.y)
        {
            l.x = (l.x >= 0.0 ? 1.0 : -1.0) * (body.half.x + 1.0);
        }
        else
        {
            l.y = (l.y >= 0.0 ? 1.0 : -1.0) * (body.half.y + 1.0);
        }
        p.pos = bodyWorld(body, l);
        p.vel = bodyPointVelocity(body, p.pos);
    }

    // Stuck in a solid (one painted over it): gone.
    if (p.type != NEUTRON && solidAt(p.pos))
    {
        kill = true;
    }

    // Beside a black hole: swallowed. Water beside a sponge with room: soaked up; beside a plant:
    // drunk. A seed where it's wet: a plant (its cell, if it's empty).
    if (!kill)
    {
        const int px = clamp(int(floor(p.pos.x)), 0, w - 1);
        const int py = clamp(int(floor(p.pos.y)), 0, h - 1);
        const int2 s = int2(px, py) + sideOffset(int(hash(seedOf(index, 30)) & 3));
        for (int o = 0; o < 4; o++)
        {
            const int2 n = int2(px, py) + sideOffset(o);
            kill = kill || (inGrid(n.x, n.y) && cellMaterial(n.x, n.y) == BLACK_HOLE);
        }
        if (!kill && p.type == WATER && inGrid(s.x, s.y))
        {
            const uint m = cellMaterial(s.x, s.y);
            const uint sc = cellIndex(s.x, s.y);
            const uint before = u_Cells[sc];
            const bool soaks = m == SPONGE && ((before >> 8) & 0xFF) < SPONGE_HOLD && random01(seedOf(index, 31)) < SOAK_RATE * dt;
            const bool drunk = m == PLANT && (before & BURNING) == 0 && ((before >> 8) & 0xFF) < 255 && random01(seedOf(index, 31)) < DRINK_RATE * dt;
            if (soaks || drunk)
            {
                uint original;
                InterlockedCompareExchange(u_Cells[sc], before, before + 0x100, original);
                kill = original == before;
            }
        }
        if (!kill && p.type == SEED && (countOf(WATER, px, py) > 0 || (inGrid(s.x, s.y) && countOf(WATER, s.x, s.y) > 0))
            && random01(seedOf(index, 32)) < SPROUT_RATE * dt)
        {
            const uint pc = cellIndex(px, py);
            uint original;
            InterlockedCompareExchange(u_Cells[pc], EMPTY, PLANT | (SEED_ENERGY << 8), original);
            kill = original == EMPTY;
        }
    }
    countEvent(EVENT_SPLASH, splash);
    countEvent(EVENT_FIZZ, fizz);
    countEvent(EVENT_FIRE, p.type == FIRE && !kill);
    countEvent(EVENT_BOOM, goesOff || (petrolLit && index % PETROL_WHOOSH == 0));
    if (kill)
    {
        p.type = EMPTY;
        storeParticle(index, p);
        freeParticle(index);
        return;
    }
    p.pos = clamp(p.pos, float2(0.001, 0.001), float2(w - 0.001, h - 0.001));
    storeParticle(index, p);
}

float2 randomInCell(int x, int y, uint seed)
{
    return float2(x + 0.05 + 0.9 * random01(seed), y + 0.05 + 0.9 * random01(seed + 1));
}

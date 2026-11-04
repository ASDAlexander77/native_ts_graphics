// The rigid bodies, a workgroup each (bodies_cs).
// (Included by powder_sandbox.hlsl, after the files before it there.)

// The bodies, a workgroup each (after the pressure solve): the liquid's pressure on the faces of
// its cells (buoyancy), gravity and drag in liquid; contacts with solids (other bodies too) at
// points along its edges, pushed out and their closing velocity taken off, with friction (off its
// center, a contact turns it: blocks tip over); then its cells drawn again where it is now. A Block
// box painted makes one in the first free record; erasing over a body's center removes it.
groupshared float4 s_BodyForce[BODY_THREADS];
groupshared Body s_Body;

bool bodyContactSolid(float2 p, uint b)
{
    const int x = int(floor(p.x));
    const int y = int(floor(p.y));
    return solidCell(x, y) && cellBody(x, y) != b;
}

void bodyBounds(Body body, out int2 lo, out int2 hi)
{
    const float reach = length(body.half) + 1.0;
    lo = int2(max(int(floor(body.pos.x - reach)), 1), max(int(floor(body.pos.y - reach)), 1));
    hi = int2(min(int(floor(body.pos.x + reach)), int(g_C.gridW) - 2), min(int(floor(body.pos.y + reach)), int(g_C.gridH) - 2));
}

[numthreads(BODY_THREADS, 1, 1)]
void bodies_cs(uint3 group : SV_GroupID, uint3 thread : SV_GroupThreadID)
{
    const uint b = group.x;
    const uint tid = thread.x;
    if (b >= MAX_BODIES)
    {
        return;
    }
    // A Block box painted: a body in the first free record, made by the first group only (each
    // looking for the first free one, a group could see another's new body and make a second).
    if (b == 0 && tid == 0 && g_C.brushMode == 2 && g_C.tool == BLOCK)
    {
        uint first = MAX_BODIES;
        for (uint k = 0; k < MAX_BODIES && first == MAX_BODIES; k++)
        {
            if (gf(F_BODY, k * BODY_FLOATS + B_ACTIVE) == 0.0)
            {
                first = k;
            }
        }
        if (first < MAX_BODIES)
        {
            const float2 a = float2(g_C.brushX0, g_C.brushY0);
            const float2 c = float2(g_C.brushX1, g_C.brushY1);
            Body made;
            made.active = true;
            made.pos = 0.5 * (a + c);
            made.angle = 0.0;
            made.vel = float2(0.0, 0.0);
            made.spin = 0.0;
            made.half = max(0.5 * abs(c - a), float2(1.0, 1.0));
            made.density = BLOCK_DENSITY;
            storeBody(first, made);
        }
    }
    DeviceMemoryBarrierWithGroupSync();
    Body body = loadBody(b);
    if (!body.active)
    {
        return;
    }
    const float dt = g_C.dt;

    // The liquid's pressure on its cells' faces.
    int2 lo;
    int2 hi;
    bodyBounds(body, lo, hi);
    const int bw = max(hi.x - lo.x + 1, 0);
    const int bh = max(hi.y - lo.y + 1, 0);
    float4 sum = float4(0.0, 0.0, 0.0, 0.0);
    for (uint k = tid; k < uint(bw * bh); k += BODY_THREADS)
    {
        const int x = lo.x + int(k % uint(bw));
        const int y = lo.y + int(k / uint(bw));
        if (cellBody(x, y) != b)
        {
            continue;
        }
        for (int o = 0; o < 4; o++)
        {
            const int nx = x + sideOffset(o).x;
            const int ny = y + sideOffset(o).y;
            if (cellBody(nx, ny) != b && fluidCell(nx, ny))
            {
                const float pressure = gf(F_P, cellIndex(nx, ny)) / dt;
                const float2 force = -pressure * float2(sideOffset(o));
                const float2 r = (float2(x, y) + float2(nx, ny)) * 0.5 + 0.5 - body.pos;
                sum += float4(force, r.x * force.y - r.y * force.x, 1.0);
            }
        }
    }
    s_BodyForce[tid] = sum;
    GroupMemoryBarrierWithGroupSync();
    for (uint stride = BODY_THREADS / 2; stride > 0; stride >>= 1)
    {
        if (tid < stride)
        {
            s_BodyForce[tid] += s_BodyForce[tid + stride];
        }
        GroupMemoryBarrierWithGroupSync();
    }

    if (tid == 0)
    {
        const float4 total = s_BodyForce[0];
        const float2 size = 2.0 * body.half;
        const float mass = body.density * size.x * size.y;
        const float inertia = mass * dot(size, size) / 12.0;
        body.vel += (gravityAt(body.pos) + total.xy / mass) * dt;
        body.spin += total.z / inertia * dt;
        // Drag where it's wet (its faces against liquid over all of them).
        const float wet = saturate(total.w / (2.0 * (size.x + size.y)));
        body.vel *= saturate(1.0 - BODY_WATER_DRAG * wet * dt);
        body.spin *= saturate(1.0 - BODY_WATER_DRAG * wet * dt);
        body.pos += body.vel * dt;
        body.angle += body.spin * dt;

        // Contacts, at points a cell apart along its edges (twice over: a push can make another).
        const int2 samples = int2(ceil(size)) + 1;
        for (uint pass = 0; pass < 2; pass++)
        {
            for (int e = 0; e < 4; e++)
            {
                const int count = e < 2 ? samples.x : samples.y;
                for (int i = 0; i < count; i++)
                {
                    const float t = count > 1 ? float(i) / float(count - 1) * 2.0 - 1.0 : 0.0;
                    const float2 l = e == 0 ? float2(t * body.half.x, -body.half.y) : (e == 1 ? float2(t * body.half.x, body.half.y)
                        : (e == 2 ? float2(-body.half.x, t * body.half.y) : float2(body.half.x, t * body.half.y)));
                    const float2 p = bodyWorld(body, l);
                    if (!bodyContactSolid(p, b))
                    {
                        continue;
                    }
                    // Out of the solid cell the shortest way into a free one.
                    const float2 cell = floor(p);
                    const float4 depths = float4(p.x - cell.x, cell.x + 1.0 - p.x, p.y - cell.y, cell.y + 1.0 - p.y);
                    float depth = 1e9;
                    float2 n = float2(0.0, -1.0);
                    for (int d = 0; d < 4; d++)
                    {
                        if (depths[d] < depth && !bodyContactSolid(cell + 0.5 + float2(sideOffset(d)), b))
                        {
                            depth = depths[d];
                            n = float2(sideOffset(d));
                        }
                    }
                    if (depth > 1.0)
                    {
                        continue;
                    }
                    body.pos += n * (depth + 0.01);
                    const float2 r = p - body.pos;
                    const float2 vp = body.vel + body.spin * float2(-r.y, r.x);
                    const float vn = dot(vp, n);
                    if (vn < 0.0)
                    {
                        const float rn = r.x * n.y - r.y * n.x;
                        const float j = -(1.0 + BODY_RESTITUTION) * vn / (1.0 / mass + rn * rn / inertia);
                        body.vel += j * n / mass;
                        body.spin += rn * j / inertia;
                        const float2 tangent = float2(-n.y, n.x);
                        const float2 vq = body.vel + body.spin * float2(-r.y, r.x);
                        const float rt = r.x * tangent.y - r.y * tangent.x;
                        const float jt = clamp(-dot(vq, tangent) / (1.0 / mass + rt * rt / inertia), -BODY_FRICTION * j, BODY_FRICTION * j);
                        body.vel += jt * tangent / mass;
                        body.spin += rt * jt / inertia;
                    }
                }
            }
        }
        if (g_C.brushMode != 0 && g_C.tool == ERASE && insideBrush(body.pos))
        {
            body.active = false;
        }
        storeBody(b, body);
        s_Body = body;
    }
    GroupMemoryBarrierWithGroupSync();

    // Its cells drawn again: the old ones cleared, the new ones where they're free (not over solids
    // or other bodies; particles there are pushed out in g2p_cs).
    for (uint k = tid; k < uint(bw * bh); k += BODY_THREADS)
    {
        const int x = lo.x + int(k % uint(bw));
        const int y = lo.y + int(k / uint(bw));
        if (cellBody(x, y) == b)
        {
            u_Cells[cellIndex(x, y)] = EMPTY;
        }
    }
    DeviceMemoryBarrierWithGroupSync();
    const Body moved = s_Body;
    if (!moved.active)
    {
        return;
    }
    int2 lo2;
    int2 hi2;
    bodyBounds(moved, lo2, hi2);
    const int bw2 = max(hi2.x - lo2.x + 1, 0);
    const int bh2 = max(hi2.y - lo2.y + 1, 0);
    for (uint k = tid; k < uint(bw2 * bh2); k += BODY_THREADS)
    {
        const int x = lo2.x + int(k % uint(bw2));
        const int y = lo2.y + int(k / uint(bw2));
        if (insideBody(moved, float2(x, y) + 0.5) && !solidCell(x, y))
        {
            u_Cells[cellIndex(x, y)] = BLOCK | (b << 8);
        }
    }
}

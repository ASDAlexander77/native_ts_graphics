// The rigid bodies' records and their shape, surface tension, and the implicit viscosity (viscosity_cs).
// (Included by powder_sandbox.hlsl, after the files before it there.)

// Rigid bodies: rectangles, MAX_BODIES records of BODY_FLOATS in F_BODY (saved with the state):
// active, center, angle (from x toward y, clockwise on screen), velocity, spin, half extents,
// density. bodies_cs moves them and draws them into the cells as BLOCK (the body in bits 8..11).
struct Body
{
    bool active;
    float2 pos;
    float angle;
    float2 vel;
    float spin;
    float2 half;
    float density;
};

Body loadBody(uint b)
{
    const uint base = b * BODY_FLOATS;
    Body body;
    body.active = gf(F_BODY, base + B_ACTIVE) != 0.0;
    body.pos = float2(gf(F_BODY, base + B_X), gf(F_BODY, base + B_Y));
    body.angle = gf(F_BODY, base + B_ANGLE);
    body.vel = float2(gf(F_BODY, base + B_VX), gf(F_BODY, base + B_VY));
    body.spin = gf(F_BODY, base + B_SPIN);
    body.half = float2(gf(F_BODY, base + B_HALFW), gf(F_BODY, base + B_HALFH));
    body.density = gf(F_BODY, base + B_DENSITY);
    return body;
}

void storeBody(uint b, Body body)
{
    const uint base = b * BODY_FLOATS;
    u_GridFloat[gi(F_BODY, base + B_ACTIVE)] = body.active ? 1.0 : 0.0;
    u_GridFloat[gi(F_BODY, base + B_X)] = body.pos.x;
    u_GridFloat[gi(F_BODY, base + B_Y)] = body.pos.y;
    u_GridFloat[gi(F_BODY, base + B_ANGLE)] = body.angle;
    u_GridFloat[gi(F_BODY, base + B_VX)] = body.vel.x;
    u_GridFloat[gi(F_BODY, base + B_VY)] = body.vel.y;
    u_GridFloat[gi(F_BODY, base + B_SPIN)] = body.spin;
    u_GridFloat[gi(F_BODY, base + B_HALFW)] = body.half.x;
    u_GridFloat[gi(F_BODY, base + B_HALFH)] = body.half.y;
    u_GridFloat[gi(F_BODY, base + B_DENSITY)] = body.density;
}

// A point in the body's own frame, and back.
float2 bodyLocal(Body body, float2 p)
{
    const float2 d = p - body.pos;
    const float c = cos(body.angle);
    const float s = sin(body.angle);
    return float2(c * d.x + s * d.y, -s * d.x + c * d.y);
}

float2 bodyWorld(Body body, float2 l)
{
    const float c = cos(body.angle);
    const float s = sin(body.angle);
    return body.pos + float2(c * l.x - s * l.y, s * l.x + c * l.y);
}

bool insideBody(Body body, float2 p)
{
    const float2 l = bodyLocal(body, p);
    return abs(l.x) <= body.half.x && abs(l.y) <= body.half.y;
}

float2 bodyPointVelocity(Body body, float2 p)
{
    const float2 r = p - body.pos;
    return body.vel + body.spin * float2(-r.y, r.x);
}

// The body a cell is drawn for, or MAX_BODIES.
uint cellBody(int x, int y)
{
    if (!inGrid(x, y))
    {
        return MAX_BODIES;
    }
    const uint word = u_Cells[cellIndex(x, y)];
    return (word & 0xFF) == BLOCK ? (word >> 8) & 15u : MAX_BODIES;
}

// A cell's liquid particles, capped at the rest count (over-full cells pulling harder would pack the
// liquid tighter and tighter); none in solid cells.
float liquidCount(int x, int y)
{
    return inGrid(x, y) && !solidCell(x, y) ? min(float(u_GridInt[gi(I_LIQUID, cellIndex(x, y))]), REST_COUNT) : 0.0;
}

// Surface tension's pull on a liquid particle in cell (x, y): toward the side of its 3 x 3 cells
// with more liquid, in cells a second squared (zero in the bulk; g2p_cs gives it the liquids, not
// powders).
float2 cohesion(int x, int y)
{
    float2 offset = float2(0.0, 0.0);
    float near = 0.0;
    for (int dy = -1; dy <= 1; dy++)
    {
        for (int dx = -1; dx <= 1; dx++)
        {
            const float n = liquidCount(x + dx, y + dy);
            offset += n * float2(dx, dy);
            near += n;
        }
    }
    // (most particles are in the bulk, their 3 x 3 cells full: no pull, and no 5 x 5 to look at)
    if (near >= 9.0 * REST_COUNT)
    {
        return float2(0.0, 0.0);
    }
    float around = near;
    for (int ry = -2; ry <= 2; ry++)
    {
        for (int rx = -2; rx <= 2; rx++)
        {
            if (abs(rx) == 2 || abs(ry) == 2)
            {
                around += liquidCount(x + rx, y + ry);
            }
        }
    }
    const float thin = saturate(1.0 - around / (TENSION_FULL * REST_COUNT));
    return near > 0.0 && thin > 0.0 ? thin * SURFACE_TENSION * offset / near : float2(0.0, 0.0);
}

// Viscosity: the faces' velocities diffused where the fluid is viscous, implicitly (stable at any
// viscosity), by red-black Gauss-Seidel sweeps of (1 + n a) u - a sum(u's neighbors) = u*, a = the
// face's viscosity * dt, u* the velocity grid_cs left (F_UOLD, plus gravity for v). Solid neighbors
// count at 0 (no slip), air ones not at all (no stress at the surface). Faces without viscosity are
// left as they are, so water is untouched. parity: the faces updated ((i + j) & 1).
float faceViscosity(uint viscSection, uint weightSection, uint t)
{
    const int weight = u_GridInt[gi(weightSection, t)];
    return weight > 0 ? float(u_GridInt[gi(viscSection, t)]) / (float(weight) / WEIGHT_SCALE) : 0.0;
}

void viscousNeighbor(bool isU, int i, int j, inout float sum, inout float n)
{
    const int w = int(g_C.gridW);
    const int h = int(g_C.gridH);
    bool solid;
    uint t;
    if (isU)
    {
        solid = i < 0 || i > w || j < 0 || j >= h || solidCell(i - 1, j) || solidCell(i, j);
        t = solid ? 0u : uIndex(i, j);
    }
    else
    {
        solid = i < 0 || i >= w || j < 0 || j > h || solidCell(i, j - 1) || solidCell(i, j);
        t = solid ? 0u : vIndex(i, j);
    }
    if (solid)
    {
        n += 1.0;
    }
    else if (u_GridInt[gi(isU ? I_UW : I_VW, t)] > 0)
    {
        sum += gf(isU ? F_U : F_V, t);
        n += 1.0;
    }
}

[numthreads(256, 1, 1)]
void viscosity_cs(uint3 id : SV_DispatchThreadID)
{
    const uint t = id.x;
    const int w = int(g_C.gridW);
    const int h = int(g_C.gridH);
    if (t < uint((w + 1) * h))
    {
        const int i = int(t % uint(w + 1));
        const int j = int(t / uint(w + 1));
        const float nu = faceViscosity(I_UVISC, I_UW, t);
        if (uint((i + j) & 1) == (g_C.parity & 1) && nu > 0.0 && !solidCell(i - 1, j) && !solidCell(i, j))
        {
            const float a = nu * g_C.dt;
            float sum = 0.0;
            float n = 0.0;
            viscousNeighbor(true, i - 1, j, sum, n);
            viscousNeighbor(true, i + 1, j, sum, n);
            viscousNeighbor(true, i, j - 1, sum, n);
            viscousNeighbor(true, i, j + 1, sum, n);
            u_GridFloat[gi(F_U, t)] = (gf(F_UOLD, t) + gravityAt(float2(i, j + 0.5)).x * g_C.dt + a * sum) / (1.0 + a * n);
        }
    }
    if (t < uint(w * (h + 1)))
    {
        const int i = int(t % uint(w));
        const int j = int(t / uint(w));
        const float nu = faceViscosity(I_VVISC, I_VW, t);
        if (uint((i + j) & 1) == (g_C.parity & 1) && nu > 0.0 && !solidCell(i, j - 1) && !solidCell(i, j))
        {
            const float a = nu * g_C.dt;
            float sum = 0.0;
            float n = 0.0;
            viscousNeighbor(false, i - 1, j, sum, n);
            viscousNeighbor(false, i + 1, j, sum, n);
            viscousNeighbor(false, i, j - 1, sum, n);
            viscousNeighbor(false, i, j + 1, sum, n);
            u_GridFloat[gi(F_V, t)] = (gf(F_VOLD, t) + gravityAt(float2(i + 0.5, j)).y * g_C.dt + a * sum) / (1.0 + a * n);
        }
    }
}

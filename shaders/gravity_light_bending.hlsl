// Light bent by gravity: a few massive bodies orbit each other (moved by the application), and
// light rays traced through their gravity field every frame (rays_cs) are drawn as paths. Where the
// field is zero a ray goes straight; past a mass it bends towards it. The same tracing, from the
// camera through every pixel (sky_ps), shows the background sky and the bodies as the bent light
// brings them: lensed, with Einstein rings around the masses.

// Donut's matrices (PlanarViewConstants) are row-major, for mul(vector, matrix).
#pragma pack_matrix(row_major)

#include <donut/shaders/view_cb.h>

// Must match the application's MAX_BODIES and MAX_POINTS.
#define MAX_BODIES 16
#define MAX_POINTS 256

// The bending modes (g_Light.z).
#define BENDING_NEWTONIAN 0
#define BENDING_WEAK_FIELD 1
#define BENDING_SCHWARZSCHILD 2
#define BENDING_NONE 3

// The emitter modes (g_EmitterOrigin.w).
#define EMITTER_SHEET 0
#define EMITTER_BEAM 1
#define EMITTER_CONE 2
#define EMITTER_SPHERE 3

cbuffer c_Scene : register(b0)
{
    // x = G, y = c (the speed of light), z = the bending mode, w = the body count.
    float4 g_Light;
    // x = a ray's length, y = seconds (the pulses' phase), z = the pulses' speed (0: none), w = the
    // radius of a sphere around the origin holding every body (the sky's tracing starts and ends on it).
    float4 g_Trace;
    // The emitter: its center and mode, the rays' direction and the beam's half width (the cone's
    // half angle, in radians), and the axes across the beam with the rays along each.
    float4 g_EmitterOrigin;
    float4 g_EmitterDirection;
    float4 g_EmitterRight; // w = rays across
    float4 g_EmitterUp;    // w = rows of rays
    // Per body: position and mass; radius and hue.
    float4 g_Bodies[MAX_BODIES];
    float4 g_BodyInfo[MAX_BODIES];
};

// --- Tracing ---------------------------------------------------------------------------------

// The Schwarzschild radius 2 G m / c^2 of a mass.
float SchwarzschildRadius(float mass)
{
    return 2.0 * g_Light.x * mass / (g_Light.y * g_Light.y);
}

// The radius at which a body stops light: its surface, or its horizon if that is larger (a black
// hole), in every mode, so that the bodies look the same whichever bends the light.
float AbsorbRadius(uint body)
{
    return max(g_BodyInfo[body].x, SchwarzschildRadius(g_Bodies[body].w));
}

// The rate at which a ray's direction turns, per unit of length, at x heading v (unit length, but
// for the Schwarzschild mode's, which only starts so).
//
// Newtonian: light is a particle at speed c, pulled by the bodies' gravity g; only g's part across
// the ray turns it (its speed stays c), by g / c^2 per unit length: a ray passing a mass m at
// distance b turns by 2 G m / (c^2 b) in all. General relativity's weak field turns it twice as
// much, 4 G m / (c^2 b) (Eddington's 1919 measurement). The Schwarzschild mode is the exact path of
// light around a single mass, x'' = -3/2 r_s h^2 x / r^5 with h = |x cross x'| (the orbit equation
// u'' + u = 3/2 r_s u^2, u = 1 / r), summed over the bodies: the weak field far away, and closer in
// the photon sphere at 1.5 r_s, where light circles the mass, and capture inside it.
float3 Bending(float3 x, float3 v)
{
    const int mode = int(g_Light.z);
    const uint count = uint(g_Light.w);
    float3 a = float3(0, 0, 0);
    if (mode == BENDING_NONE)
        return a;

    [loop]
    for (uint i = 0; i < count; i++)
    {
        const float3 r = x - g_Bodies[i].xyz;
        const float r2 = dot(r, r);
        const float r1 = sqrt(r2);
        if (mode == BENDING_SCHWARZSCHILD)
        {
            const float3 h = cross(r, v);
            a -= 1.5 * SchwarzschildRadius(g_Bodies[i].w) * dot(h, h) * r / (r2 * r2 * r1);
        }
        else
        {
            a -= g_Light.x * g_Bodies[i].w * r / (r2 * r1);
        }
    }
    if (mode == BENDING_SCHWARZSCHILD)
        return a;

    const float factor = mode == BENDING_WEAK_FIELD ? 2.0 : 1.0;
    return factor * (a - dot(a, v) * v) / (g_Light.y * g_Light.y);
}

// The distance from x to the nearest body's absorbing surface (negative inside one), and which.
float NearestSurface(float3 x, out int nearest)
{
    const uint count = uint(g_Light.w);
    float distance = 1.0e30;
    nearest = -1;
    [loop]
    for (uint i = 0; i < count; i++)
    {
        const float d = length(x - g_Bodies[i].xyz) - AbsorbRadius(i);
        if (d < distance)
        {
            distance = d;
            nearest = int(i);
        }
    }
    return distance;
}

// A step's length: a fifth of the way to the nearest surface (the field changes over that
// distance), between STEP_MIN and stepMax.
#define STEP_MIN 0.002
#define STEP_FRACTION 0.2

float StepLength(float surfaceDistance, float stepMax)
{
    return clamp(STEP_FRACTION * surfaceDistance, STEP_MIN, stepMax);
}

// One Runge-Kutta step of length h along the ray at x heading v. A ray with nothing bending it
// (Bending 0) moves by exactly h v: a straight line.
void TraceStep(inout float3 x, inout float3 v, float h)
{
    const float3 a1 = Bending(x, v);
    const float3 x2 = x + 0.5 * h * v;
    const float3 v2 = v + 0.5 * h * a1;
    const float3 a2 = Bending(x2, v2);
    const float3 x3 = x + 0.5 * h * v2;
    const float3 v3 = v + 0.5 * h * a2;
    const float3 a3 = Bending(x3, v3);
    const float3 x4 = x + h * v3;
    const float3 v4 = v + h * a3;
    const float3 a4 = Bending(x4, v4);
    x += h / 6.0 * (v + 2.0 * v2 + 2.0 * v3 + v4);
    v += h / 6.0 * (a1 + 2.0 * a2 + 2.0 * a3 + a4);
    // Light keeps its speed: the Newtonian and weak-field modes turn the direction only, and
    // the step's rounding mustn't change its length. The Schwarzschild mode's path is right
    // with whatever speed its equation gives.
    if (int(g_Light.z) != BENDING_SCHWARZSCHILD)
        v = normalize(v);
}

// A color of the given hue, fully saturated.
float3 Hue(float hue)
{
    return saturate(abs(frac(hue + float3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0);
}

// --- Rays ------------------------------------------------------------------------------------

// A ray's path: its points (xyz, and w the length along the ray to it), MAX_POINTS of them per ray,
// and what became of it.
struct Ray
{
    float4 origin; // xyz = where it started, w = its place across the beam, 0 to 1 (its color)
    float4 start;  // xyz = the direction it started in, w = how many points its path has
    float4 end;    // xyz = the direction it ended in, w = the length it went
    float4 fate;   // x = the body that stopped it (-1: none), y = the steps taken
};

// Where ray `index` of the emitter's starts, and in which direction, and its place across the beam.
void EmitRay(uint index, out float3 origin, out float3 direction, out float across)
{
    const int mode = int(g_EmitterOrigin.w);
    const uint columns = max(uint(g_EmitterRight.w), 1u);
    const uint rows = mode == EMITTER_SHEET ? 1u : max(uint(g_EmitterUp.w), 1u);
    const uint column = index % columns;
    const uint row = index / columns;
    // -1 to 1 across the beam (0 for a single ray).
    const float u = columns > 1 ? 2.0 * column / (columns - 1) - 1.0 : 0.0;
    const float v = rows > 1 ? 2.0 * row / (rows - 1) - 1.0 : 0.0;
    across = 0.5 + 0.5 * u;

    const float3 forward = g_EmitterDirection.xyz;
    const float3 right = g_EmitterRight.xyz;
    const float3 up = g_EmitterUp.xyz;
    origin = g_EmitterOrigin.xyz;
    direction = forward;
    if (mode == EMITTER_SHEET || mode == EMITTER_BEAM)
    {
        // Parallel rays, from points spread over the beam's width.
        origin += g_EmitterDirection.w * (u * right + v * up);
    }
    else if (mode == EMITTER_CONE)
    {
        // From the one point, spread over the cone's angle both ways.
        const float angle = g_EmitterDirection.w;
        direction = normalize(forward + tan(u * angle) * right + tan(v * angle) * up);
    }
    else
    {
        // From the one point, in every direction: a Fibonacci spiral over the sphere.
        const uint count = columns * rows;
        const float z = 1.0 - 2.0 * (index + 0.5) / count;
        const float ring = sqrt(saturate(1.0 - z * z));
        const float turn = index * 2.399963;
        direction = normalize(z * forward + ring * (cos(turn) * right + sin(turn) * up));
        across = (index + 0.5) / count;
    }
}

#ifdef RAYS

RWStructuredBuffer<float4> u_Points : register(u0);
RWStructuredBuffer<Ray> u_Rays : register(u1);

// The tracing's limits: steps per ray, the longest step, and when the path gets a point: after this
// much length, or when the ray has turned by this much (the cosine of the angle) since the last one.
#define MAX_STEPS 4096
#define RAY_STEP_MAX 0.25
#define POINT_SPACING 0.5
#define POINT_TURN_COS 0.9994

#define RAYS_GROUP_SIZE 64

// Each thread traces one ray from the emitter, until it has gone g_Trace.x or a body stops it,
// writing the points of its path.
[numthreads(RAYS_GROUP_SIZE, 1, 1)]
void rays_cs(uint3 globalId : SV_DispatchThreadID)
{
    const uint index = globalId.x;
    const int mode = int(g_EmitterOrigin.w);
    const uint columns = max(uint(g_EmitterRight.w), 1u);
    const uint rows = mode == EMITTER_SHEET ? 1u : max(uint(g_EmitterUp.w), 1u);
    if (index >= columns * rows)
        return;

    float3 origin;
    float3 direction;
    float across;
    EmitRay(index, origin, direction, across);

    const uint base = index * MAX_POINTS;
    float3 x = origin;
    float3 v = direction;
    float travelled = 0.0;
    uint points = 1;
    u_Points[base] = float4(x, 0.0);
    float3 lastDirection = normalize(v);
    float lastLength = 0.0;
    int stoppedBy = -1;
    uint steps = 0;

    // Started inside a body: stopped at once.
    int nearest;
    if (NearestSurface(x, nearest) < 0.0)
        stoppedBy = nearest;

    const float maxLength = g_Trace.x;
    [loop]
    for (; steps < MAX_STEPS && stoppedBy < 0 && travelled < maxLength; steps++)
    {
        const float h = min(StepLength(NearestSurface(x, nearest), RAY_STEP_MAX), maxLength - travelled);
        const float3 before = x;
        TraceStep(x, v, h);
        travelled += length(x - before);

        if (NearestSurface(x, nearest) < 0.0)
            stoppedBy = nearest;

        // A point where the path has gone far enough, or turned enough, since the last, and at its
        // end. When the buffer is full, the last point moves on with the ray: the path still ends
        // where the ray does.
        const float3 heading = normalize(v);
        const bool last = stoppedBy >= 0 || travelled >= maxLength || steps + 1 >= MAX_STEPS;
        if (last || travelled - lastLength >= POINT_SPACING || dot(heading, lastDirection) < POINT_TURN_COS)
        {
            const uint slot = min(points, uint(MAX_POINTS - 1));
            u_Points[base + slot] = float4(x, travelled);
            points = slot + 1;
            lastDirection = heading;
            lastLength = travelled;
        }
    }

    Ray ray;
    ray.origin = float4(origin, across);
    ray.start = float4(direction, float(points));
    ray.end = float4(normalize(v), travelled);
    ray.fate = float4(float(stoppedBy), float(steps), 0.0, 0.0);
    u_Rays[index] = ray;
}

#endif // RAYS

// --- Drawing ---------------------------------------------------------------------------------

cbuffer c_View : register(b1)
{
    PlanarViewConstants g_View;
};

StructuredBuffer<float4> t_Points : register(t0);
StructuredBuffer<Ray> t_Rays : register(t1);

// Lines are quads of 6 vertices, clockwise on screen (NVRHI's default front faces).
static const uint c_QuadIndex[6] = { 0, 1, 2, 0, 2, 3 };
static const float2 c_QuadCorners[6] = {
    float2(-1, -1), float2(-1, 1), float2(1, 1),
    float2(-1, -1), float2(1, 1), float2(1, -1)
};

#define NEAR_DEPTH 0.1

// A world-space segment from p0 to p1 as a screen-space quad, halfWidth pixels either side: its
// clip-space corner for vertex i_vertex % 6, and where along the segment that is (0 or 1). Cut at
// the near plane; behind the camera altogether, a degenerate quad off screen.
float4 SegmentCorner(float3 p0, float3 p1, float halfWidth, uint vertex, out float along01)
{
    along01 = 0.0;
    float4 e0 = mul(float4(p0, 1.0), g_View.matWorldToView);
    float4 e1 = mul(float4(p1, 1.0), g_View.matWorldToView);
    if (e0.z < NEAR_DEPTH && e1.z < NEAR_DEPTH)
        return float4(2, 2, 0, 1);
    if (e0.z < NEAR_DEPTH)
        e0 = lerp(e0, e1, (NEAR_DEPTH - e0.z) / (e1.z - e0.z));
    if (e1.z < NEAR_DEPTH)
        e1 = lerp(e1, e0, (NEAR_DEPTH - e1.z) / (e0.z - e1.z));

    const float4 c0 = mul(e0, g_View.matViewToClip);
    const float4 c1 = mul(e1, g_View.matViewToClip);
    // In pixels from the center of the viewport, y up.
    const float2 halfViewport = 0.5 / g_View.viewportSizeInv;
    const float2 s0 = c0.xy / c0.w * halfViewport;
    const float2 s1 = c1.xy / c1.w * halfViewport;
    float2 along = s1 - s0;
    const float length_ = length(along);
    along = length_ > 1e-4 ? along / length_ : float2(1, 0);
    const float2 across = float2(-along.y, along.x) * halfWidth;

    // Joined to the next segment without a gap: no overhang past the ends (the adjoining quads
    // overlap a little at a bend, which the additive blend shows as a brighter dot).
    const float2 corners[4] = { s0 - across, s0 + across, s1 + across, s1 - across };
    const uint corner = c_QuadIndex[vertex % 6];
    along01 = corner >= 2 ? 1.0 : 0.0;
    return float4(corners[corner] * g_View.viewportSizeInv * 2.0, 0.0, 1.0);
}

#define PATH_HALF_WIDTH 0.9
// The pulses along the paths: their spacing and their length, in scene units.
#define PULSE_SPACING 6.0
#define PULSE_LENGTH 1.2

// The rays' paths: MAX_POINTS - 1 segments per ray, those past its last point degenerate.
void path_vs(
    uint i_vertex : SV_VertexID,
    out float4 o_position : SV_Position,
    out float4 o_color : TEXCOORD0,
    out float2 o_pulse : TEXCOORD1)
{
    const uint segment = i_vertex / 6;
    const uint rayIndex = segment / (MAX_POINTS - 1);
    const uint point_ = segment % (MAX_POINTS - 1);
    const Ray ray = t_Rays[rayIndex];
    o_position = float4(2, 2, 0, 1);
    o_color = 0;
    o_pulse = 0;
    if (point_ + 1 >= uint(ray.start.w))
        return;

    const float4 a = t_Points[rayIndex * MAX_POINTS + point_];
    const float4 b = t_Points[rayIndex * MAX_POINTS + point_ + 1];
    float along;
    o_position = SegmentCorner(a.xyz, b.xyz, PATH_HALF_WIDTH, i_vertex, along);
    // Where along the pulses' pattern this is (the pattern moves on at the pulses' speed), and
    // whether there are pulses.
    o_pulse = float2(lerp(a.w, b.w, along) - g_Trace.y * g_Trace.z, g_Trace.z > 0.0 ? 1.0 : 0.0);
    // Dimmer the more rays there are, so that a dense beam doesn't add up to white: as bright as
    // the default sheet's 41 at most.
    const int mode = int(g_EmitterOrigin.w);
    const float rays = max(g_EmitterRight.w, 1.0) * (mode == EMITTER_SHEET ? 1.0 : max(g_EmitterUp.w, 1.0));
    o_color = float4(lerp(Hue(0.8 * ray.origin.w), float3(1, 1, 1), 0.25), 0.55) * min(1.0, sqrt(41.0 / rays));
}

float4 path_ps(
    float4 i_position : SV_Position,
    float4 i_color : TEXCOORD0,
    float2 i_pulse : TEXCOORD1) : SV_Target0
{
    // Pulses of light running along the paths at the speed of light (in the time scale), so the
    // direction the light goes in shows: a bright head, and a tail fading behind it.
    float brightness = i_color.a;
    if (i_pulse.y > 0.5)
    {
        const float phase = frac(i_pulse.x / PULSE_SPACING) * PULSE_SPACING;
        brightness += 1.2 * saturate(1.0 - (PULSE_SPACING - phase) / PULSE_LENGTH) + 0.4 * saturate(1.0 - phase / 0.15);
    }
    return float4(i_color.rgb * brightness, 1.0);
}

// The same rays without the bending: straight, faint lines from where each starts, as long as it
// would go, to compare against.
void straight_vs(
    uint i_vertex : SV_VertexID,
    out float4 o_position : SV_Position,
    out float4 o_color : TEXCOORD0)
{
    const uint rayIndex = i_vertex / 6;
    float3 origin;
    float3 direction;
    float across;
    EmitRay(rayIndex, origin, direction, across);
    float along;
    o_position = SegmentCorner(origin, origin + direction * g_Trace.x, 0.6, i_vertex, along);
    o_color = float4(0.35, 0.35, 0.4, 1.0) * (1.0 - 0.7 * along);
}

float4 color_ps(
    float4 i_position : SV_Position,
    float4 i_color : TEXCOORD0) : SV_Target0
{
    return i_color;
}

// The XZ plane's grid through the origin: 2 * PLANE_LINES lines, PLANE_SPACING apart.
#define PLANE_HALF_LINES 10
#define PLANE_LINES (2 * PLANE_HALF_LINES + 1)
#define PLANE_SPACING 2.0

void grid_vs(
    uint i_vertex : SV_VertexID,
    out float4 o_position : SV_Position,
    out float4 o_color : TEXCOORD0)
{
    const uint line_ = i_vertex / 6;
    const uint direction = line_ / PLANE_LINES;
    const int index = int(line_ % PLANE_LINES) - PLANE_HALF_LINES;
    const float u = index * PLANE_SPACING;
    const float extent = PLANE_HALF_LINES * PLANE_SPACING;
    float3 p0 = float3(u, 0, -extent);
    float3 p1 = float3(u, 0, extent);
    if (direction != 0)
    {
        p0 = float3(-extent, 0, u);
        p1 = float3(extent, 0, u);
    }
    float along;
    o_position = SegmentCorner(p0, p1, 0.6, i_vertex, along);
    const bool axis = index == 0;
    o_color = float4(0.3, 0.6, 0.35, axis ? 0.4 : 0.15);
}

// The bodies, as screen-aligned quads twice their size: lit spheres in their color, a black hole
// (its horizon larger than the body) as a black disk with a thin bright rim.
void body_vs(
    uint i_vertex : SV_VertexID,
    out float4 o_position : SV_Position,
    out float2 o_coord : TEXCOORD0,
    out float4 o_color : TEXCOORD1)
{
    const uint body = i_vertex / 6;
    const float2 corner = c_QuadCorners[i_vertex % 6];
    const float radius = AbsorbRadius(body);
    const float4 eyePos = mul(float4(g_Bodies[body].xyz, 1.0), g_View.matWorldToView);
    o_position = mul(eyePos, g_View.matViewToClip);
    const float halfSize = 2.0 * radius;
    const float2 ndcHalfSize = max(halfSize * float2(g_View.matViewToClip[0][0], g_View.matViewToClip[1][1]) / o_position.w,
        3.0 * g_View.viewportSizeInv);
    o_position.xy += corner * ndcHalfSize * o_position.w;
    if (eyePos.z < NEAR_DEPTH)
        o_position = float4(2, 2, 0, 1);
    o_coord = corner * 2.0;
    const bool blackHole = SchwarzschildRadius(g_Bodies[body].w) >= g_BodyInfo[body].x;
    o_color = float4(lerp(Hue(g_BodyInfo[body].y), float3(1, 1, 1), 0.45), blackHole ? 1.0 : 0.0);
}

float4 body_ps(
    float4 i_position : SV_Position,
    float2 i_coord : TEXCOORD0,
    float4 i_color : TEXCOORD1) : SV_Target0
{
    const float r = length(i_coord);
    if (i_color.a > 0.5)
    {
        // A black hole: black within the horizon, a rim just outside it, fading.
        const float rim = saturate(1.0 - abs(r - 1.08) / 0.08);
        const float glow = r > 1.0 ? 0.25 * saturate(1.0 - (r - 1.0)) : 0.0;
        if (r < 1.0)
            return float4(0, 0, 0, 1);
        return float4(float3(1.0, 0.6, 0.25) * (rim + glow), saturate(rim + glow));
    }
    if (r >= 1.0)
    {
        // The glow around a star.
        const float glow = 0.35 * pow(saturate(1.0 - (r - 1.0)), 3.0);
        return float4(i_color.rgb, glow);
    }
    // A sphere lit from the upper left in front.
    const float3 normal = float3(i_coord, -sqrt(1.0 - r * r));
    const float3 toLight = normalize(float3(-0.45, 0.55, -0.7));
    const float brightness = 0.35 + 0.8 * saturate(dot(normal, toLight));
    return float4(i_color.rgb * brightness, 1.0);
}

// --- The lensed sky --------------------------------------------------------------------------

// A triangle over the screen, its vertices winding clockwise on the screen (Donut's front faces).
void sky_vs(uint vertexId : SV_VertexID, out float4 position : SV_Position)
{
    float2 pos = float2(-1.0, -1.0);
    if (vertexId == 1)
        pos = float2(3.0, -1.0);
    else if (vertexId == 2)
        pos = float2(-1.0, 3.0);
    position = float4(pos.x, -pos.y, 0.0, 1.0);
}

float Hash(float3 p)
{
    p = frac(p * float3(443.897, 441.423, 437.195));
    p += dot(p, p.yzx + 19.19);
    return frac((p.x + p.y) * p.z);
}

// The sky far away in direction d: stars (one per cell of a grid on the unit sphere's cube, at most),
// faint lines of longitude and latitude every 15 degrees, and a glowing band along the XZ plane.
float3 Sky(float3 d)
{
    float3 color = float3(0.004, 0.005, 0.012);

    // Stars.
    const float cells = 180.0;
    const float3 p = d * cells;
    const float3 cell = floor(p);
    const float h = Hash(cell);
    if (h > 0.93)
    {
        const float3 center = cell + 0.5 + 0.35 * (float3(Hash(cell + 7.1), Hash(cell + 3.7), Hash(cell + 1.3)) - 0.5);
        const float distance = length(p - center);
        const float brightness = pow(saturate(1.0 - distance / 0.35), 2.0) * (h - 0.93) / 0.07;
        color += brightness * lerp(float3(1.0, 0.8, 0.6), float3(0.7, 0.8, 1.0), Hash(cell + 11.0)) * 2.0;
    }

    // The grid, by angle: its lines a constant width on screen.
    const float longitude = atan2(d.z, d.x);
    const float latitude = asin(clamp(d.y, -1.0, 1.0));
    const float spacing = radians(15.0);
    const float2 angles = float2(longitude, latitude) / spacing;
    const float2 distanceToLine = abs(frac(angles + 0.5) - 0.5) * spacing;
    const float lineWidth = 0.0015;
    float gridLine = saturate(1.0 - distanceToLine.y / lineWidth);
    gridLine = max(gridLine, saturate(1.0 - distanceToLine.x * cos(latitude) / lineWidth));
    color += float3(0.03, 0.05, 0.09) * gridLine;

    // A band of light along the equator, as a galaxy's.
    color += float3(0.06, 0.045, 0.08) * exp(-d.y * d.y * 60.0);
    return color;
}

#define SKY_MAX_STEPS 384
#define SKY_STEP_MAX 1.0

// Each pixel traces the light that reaches the camera through it, backwards (the paths are the same
// either way): from the camera, until it leaves the sphere around the bodies (the sky beyond it,
// in the direction it then has) or a body stops it (its surface, as the light left it).
float4 sky_ps(float4 i_position : SV_Position) : SV_Target0
{
    const float2 ndc = float2(2.0, -2.0) * (i_position.xy - g_View.viewportOrigin) * g_View.viewportSizeInv + float2(-1.0, 1.0);
    const float4 viewPoint = mul(float4(ndc, 1.0, 1.0), g_View.matClipToViewNoOffset);
    const float3 viewDirection = normalize(viewPoint.xyz / viewPoint.w);
    float3 v = normalize(mul(float4(viewDirection, 0.0), g_View.matViewToWorld).xyz);
    float3 x = g_View.matViewToWorld[3].xyz;

    // Outside the sphere around the bodies, the light is straight up to it: from where it enters.
    const float radius = g_Trace.w;
    const float b = dot(x, v);
    const float c = dot(x, x) - radius * radius;
    if (c > 0.0)
    {
        const float discriminant = b * b - c;
        if (b > 0.0 || discriminant < 0.0)
            return float4(Sky(v), 1.0);
        x += (-b - sqrt(discriminant)) * v;
    }

    int nearest;
    [loop]
    for (uint i = 0; i < SKY_MAX_STEPS; i++)
    {
        const float surface = NearestSurface(x, nearest);
        if (surface < 0.0)
        {
            // A star's surface, darker towards its limb; a black hole's horizon, black.
            const float3 center = g_Bodies[nearest].xyz;
            if (SchwarzschildRadius(g_Bodies[nearest].w) >= g_BodyInfo[nearest].x)
                return float4(0, 0, 0, 1);
            const float3 normal = normalize(x - center);
            const float limb = saturate(-dot(normal, normalize(v)));
            const float3 color = lerp(Hue(g_BodyInfo[nearest].y), float3(1, 1, 1), 0.45);
            return float4(color * (0.35 + 0.75 * sqrt(limb)), 1.0);
        }
        // Left the sphere, heading out: the sky.
        if (dot(x, x) > radius * radius && dot(x, v) > 0.0)
            break;
        TraceStep(x, v, StepLength(surface, SKY_STEP_MAX));
    }
    return float4(Sky(normalize(v)), 1.0);
}

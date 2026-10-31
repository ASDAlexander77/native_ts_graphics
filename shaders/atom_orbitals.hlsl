// Hydrogen orbitals as a Bohmian flow: particles distributed as |psi|^2 move with the guidance velocity
// v = Im(conj(psi) grad psi) / |psi|^2 (atomic units: hbar = electron mass = Bohr radius = 1), which
// keeps them distributed as |psi(t)|^2 as the wave function evolves. psi is one eigenstate, or two
// superposed: a psi_A + b psi_B e^(-i dE t) (a common phase factor dropped, it doesn't move anything).

// Donut's matrices (PlanarViewConstants) are row-major, for mul(vector, matrix).
#pragma pack_matrix(row_major)

#include <donut/shaders/binding_helpers.hlsli>
#include <donut/shaders/view_cb.h>

struct Particle
{
    float4 pos; // xyz = position (Bohr radii), w = phase of psi there, arg(psi) in [-pi, pi]
    float4 vel; // xyz = guidance velocity (Bohr radii per atomic time unit), w unused
};

static const float PI = 3.14159265;

// --- Simulation ------------------------------------------------------------------------------

#ifdef SIMULATION

// All floats (the push constants are one f32 array on the TypeScript side): the integers convert here.
struct SimulationConstants
{
    float deltaT;        // atomic time units this frame
    float particleCount;
    float phase;         // dE t at the start of the frame, wrapped to [0, 2 pi)
    float deltaE;        // E_B - E_A
    float maxStep;       // longest move in one substep (Bohr radii)
    float gradientStep;  // h of the central differences
    float amplitudeA;
    float amplitudeB;    // 0: psi_A alone
    float4 stateA;       // n, l, m, normalization (radial times angular)
    float4 stateB;
};
DECLARE_PUSH_CONSTANTS(SimulationConstants, g_Simulation, 0, 0);
RWStructuredBuffer<Particle> u_Particles : register(u0);

#define WORKGROUP_SIZE 256
// Substeps a particle takes in a frame, at most: near a node of psi (the z axis of an m != 0 state)
// the flow turns fast and the steps get short; a particle there runs out of them and lags behind in
// time, which is where hardly any particles are (|psi|^2 vanishes there).
#define MAX_SUBSTEPS 128
// A substep moves a particle by at most this share of |psi| / |grad psi|, the distance at which psi
// changes by itself (near a node, about the distance to it).
#define NODE_STEP_SHARE 0.1

float2 ComplexMul(float2 a, float2 b)
{
    return float2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

// R_nl(r) over its normalization: (2r/n)^l e^(-r/n) L_(n-l-1)^(2l+1)(2r/n), the generalized Laguerre
// polynomial by its three-term recurrence.
float Radial(int n, int l, float r)
{
    const float x = 2.0 * r / n;
    const int k = n - l - 1;
    const float alpha = 2 * l + 1;
    float previous = 1.0;
    float laguerre = 1.0;
    if (k > 0)
    {
        laguerre = 1.0 + alpha - x;
        for (int j = 1; j < k; j++)
        {
            const float next = ((2 * j + 1 + alpha - x) * laguerre - (j + alpha) * previous) / (j + 1);
            previous = laguerre;
            laguerre = next;
        }
    }
    // x^l by multiplication: pow(0, 0) is NaN.
    float power = 1.0;
    for (int i = 0; i < l; i++)
        power *= x;
    return power * exp(-0.5 * x) * laguerre;
}

// The m-th derivative of the Legendre polynomial P_l at t (P_l^m without its (1 - t^2)^(m/2) factor
// and the Condon-Shortley sign), m >= 0, by the recurrence in l.
float LegendreReduced(int l, int m, float t)
{
    // P_m^m: (2m - 1)!!.
    float pmm = 1.0;
    for (int i = 1; i <= m; i++)
        pmm *= 2 * i - 1;
    if (l == m)
        return pmm;
    float previous = pmm;
    float current = (2 * m + 1) * t * pmm;
    for (int k = m + 1; k < l; k++)
    {
        const float next = ((2 * k + 1) * t * current - (k + m) * previous) / (k - m + 1);
        previous = current;
        current = next;
    }
    return current;
}

// psi_nlm at p, times its normalization: R_nl(r) P_l^|m|(z / r) e^(i m phi). (1 - t^2)^(|m|/2) e^(i m phi)
// is ((x +- i y) / r)^|m|, with no division by the distance to the z axis.
float2 Eigenstate(float4 state, float3 p)
{
    const int n = int(state.x);
    const int l = int(state.y);
    const int m = int(state.z);
    const float r = max(length(p), 1.0e-6);
    const float real = state.w * Radial(n, l, r) * LegendreReduced(l, abs(m), p.z / r);
    const float2 w = float2(p.x, m < 0 ? -p.y : p.y) / r;
    float2 psi = float2(real, 0.0);
    for (int i = 0; i < abs(m); i++)
        psi = ComplexMul(psi, w);
    return psi;
}

// The superposition at p, dE t = phase.
float2 Psi(float3 p, float phase)
{
    float2 psi = g_Simulation.amplitudeA * Eigenstate(g_Simulation.stateA, p);
    if (g_Simulation.amplitudeB != 0.0)
    {
        const float2 rotation = float2(cos(phase), -sin(phase));
        psi += g_Simulation.amplitudeB * ComplexMul(Eigenstate(g_Simulation.stateB, p), rotation);
    }
    return psi;
}

// The guidance velocity at p, and in w the distance psi changes by itself, |psi| / |grad psi| (or a
// large one where psi doesn't change). Central differences for the gradient.
float4 Velocity(float3 p, float phase)
{
    const float2 psi = Psi(p, phase);
    const float h = g_Simulation.gradientStep;
    const float2 dx = Psi(p + float3(h, 0, 0), phase) - Psi(p - float3(h, 0, 0), phase);
    const float2 dy = Psi(p + float3(0, h, 0), phase) - Psi(p - float3(0, h, 0), phase);
    const float2 dz = Psi(p + float3(0, 0, h), phase) - Psi(p - float3(0, 0, h), phase);
    const float density = dot(psi, psi);
    if (density < 1.0e-30)
        return float4(0, 0, 0, 0);
    // Im(conj(psi) d) for each axis' difference d, over 2h.
    const float3 flux = float3(
        psi.x * dx.y - psi.y * dx.x,
        psi.x * dy.y - psi.y * dy.x,
        psi.x * dz.y - psi.y * dz.x) / (2.0 * h);
    const float gradient = sqrt(dot(dx, dx) + dot(dy, dy) + dot(dz, dz)) / (2.0 * h);
    const float scale = gradient > 0.0 ? sqrt(density) / gradient : 1.0e6;
    return float4(flux / density, scale);
}

// Moves every particle along the flow for the frame's time, in RK4 substeps no longer than maxStep
// nor a share of the distance psi changes over, then stores its velocity and the phase of psi there.
[numthreads(WORKGROUP_SIZE, 1, 1)]
void advance_cs(uint3 globalId : SV_DispatchThreadID)
{
    const uint index = globalId.x;
    if (index >= uint(g_Simulation.particleCount))
        return;

    float3 p = u_Particles[index].pos.xyz;
    const float dE = g_Simulation.deltaE;
    float time = 0.0;
    float4 v = Velocity(p, g_Simulation.phase);
    for (int i = 0; i < MAX_SUBSTEPS && time < g_Simulation.deltaT; i++)
    {
        const float speed = length(v.xyz);
        float h = g_Simulation.deltaT - time;
        const float reach = min(g_Simulation.maxStep, NODE_STEP_SHARE * v.w);
        if (speed * h > reach)
            h = reach / speed;
        const float phase = g_Simulation.phase + dE * time;
        const float3 k1 = v.xyz;
        const float3 k2 = Velocity(p + 0.5 * h * k1, phase + 0.5 * dE * h).xyz;
        const float3 k3 = Velocity(p + 0.5 * h * k2, phase + 0.5 * dE * h).xyz;
        const float3 k4 = Velocity(p + h * k3, phase + dE * h).xyz;
        p += h / 6.0 * (k1 + 2.0 * k2 + 2.0 * k3 + k4);
        time += h;
        v = Velocity(p, g_Simulation.phase + dE * time);
    }

    const float2 psi = Psi(p, g_Simulation.phase + dE * g_Simulation.deltaT);
    u_Particles[index].pos = float4(p, atan2(psi.y, psi.x));
    u_Particles[index].vel = float4(v.xyz, 0.0);
}

#endif // SIMULATION

// --- Rendering -------------------------------------------------------------------------------

cbuffer c_View : register(b1)
{
    PlanarViewConstants g_View;
};

struct DisplayConstants
{
    float spriteSize;   // world size of a particle's quad
    float brightness;
    float colorMode;    // 0: phase of psi, 1: speed
    float speedScale;   // the speed shown at the top of the gradient
    float cutAway;      // 1: particles with x > 0 hidden
    float particleCount;
    float nucleusSize;
    float padding;
};
cbuffer c_Display : register(b2)
{
    DisplayConstants g_Display;
};
StructuredBuffer<Particle> t_Particles : register(t0);

// Each particle is a screen-aligned quad of 6 vertices, as in compute_nbody; one more quad after the
// particles is the nucleus. Clockwise on screen, the front faces of NVRHI's default raster state.
static const float2 c_QuadCorners[6] = {
    float2(-1, -1), float2(-1, 1), float2(1, 1),
    float2(-1, -1), float2(1, 1), float2(1, -1)
};

// Hue wheel: the phase of psi in [-pi, pi] around red, yellow, green, cyan, blue, magenta.
float3 Hue(float phase)
{
    const float h = (phase + PI) / (2.0 * PI) * 6.0;
    return saturate(float3(abs(h - 3.0) - 1.0, 2.0 - abs(h - 2.0), 2.0 - abs(h - 4.0)));
}

// Slow to fast: deep blue, cyan, white.
float3 SpeedColor(float speed)
{
    const float u = saturate(speed / g_Display.speedScale);
    return u < 0.5 ? lerp(float3(0.05, 0.15, 0.9), float3(0.1, 0.9, 1.0), 2.0 * u)
                   : lerp(float3(0.1, 0.9, 1.0), float3(1.0, 1.0, 1.0), 2.0 * u - 1.0);
}

void main_vs(
    uint i_vertex : SV_VertexID,
    out float4 o_position : SV_Position,
    out float2 o_spriteCoord : TEXCOORD0,
    out float3 o_color : COLOR0)
{
    const uint index = i_vertex / 6;
    const float2 corner = c_QuadCorners[i_vertex % 6];

    float3 position = float3(0, 0, 0);
    float size = g_Display.nucleusSize;
    float3 color = float3(1.0, 0.85, 0.6);
    if (index < uint(g_Display.particleCount))
    {
        const Particle particle = t_Particles[index];
        position = particle.pos.xyz;
        size = g_Display.spriteSize;
        color = g_Display.brightness
            * (g_Display.colorMode == 0.0 ? Hue(particle.pos.w) : SpeedColor(length(particle.vel.xyz)));
        if (g_Display.cutAway != 0.0 && position.x > 0.0)
            size = 0.0;
    }

    // The quantization axis z up: Donut's camera has y up. (x, y, z) -> (x, z, -y) turns the scene by
    // -90 degrees about x, no mirror image, which would turn the m > 0 flow the other way.
    const float3 world = float3(position.x, position.z, -position.y);
    // A quad of the world size, facing the camera: offset in view space.
    const float4 eyePos = mul(float4(world, 1.0), g_View.matWorldToView);
    o_position = mul(eyePos + float4(corner * 0.5 * size, 0.0, 0.0), g_View.matViewToClip);
    o_spriteCoord = corner;
    o_color = color;
}

float4 main_ps(
    float4 i_position : SV_Position,
    float2 i_spriteCoord : TEXCOORD0,
    float3 i_color : COLOR0) : SV_Target0
{
    // A soft round glow, black at the quad's edge.
    const float r2 = dot(i_spriteCoord, i_spriteCoord);
    const float glow = r2 < 1.0 ? (1.0 - r2) * (1.0 - r2) : 0.0;
    return float4(glow * i_color, 1);
}

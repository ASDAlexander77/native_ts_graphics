// The HUD's probe: the cell under the pointer, the counts and the wind, read back each frame.
// (Included by powder_sandbox.hlsl, after the files before it there.)

// The HUD's readout at the probed cell: temperature, pressure (in cells of water depth), material,
// the particles in it.
[numthreads(1, 1, 1)]
void probe_cs(uint3 id : SV_DispatchThreadID)
{
    const int x = clamp(int(floor(g_C.probeX)), 0, int(g_C.gridW) - 1);
    const int y = clamp(int(floor(g_C.probeY)), 0, int(g_C.gridH) - 1);
    const uint c = cellIndex(x, y);
    u_Alloc[A_PROBE + 0] = asint(gf(F_TCELL, c));
    u_Alloc[A_PROBE + 1] = asint(gf(F_P, c) / (g_C.dt * g_C.gravity));
    u_Alloc[A_PROBE + 2] = int(u_Cells[c]);
    // The count sections' counts four to an int (8 bits each, the first of four lowest), from
    // A_PROBE + 3 up to under the wind at A_PROBE + 9: up to 24 types. (u_Alloc is saved, so A_LIST
    // stays put.)
    for (uint k = 0; k < (PARTICLE_TYPES + 3) / 4; k++)
    {
        uint packed = 0u;
        for (uint j = 0; j < 4; j++)
        {
            const uint s = 4 * k + j;
            packed |= (s < PARTICLE_TYPES ? min(uint(u_GridInt[gi(I_COUNT + s, c)]), 255u) : 0u) << (8 * j);
        }
        u_Alloc[A_PROBE + 3 + k] = int(packed);
    }
    u_Alloc[A_LIST - 1] = asint(cellSalinity(c, x, y));
    // The wind there (u_Alloc[A_PROBE + 9 .. 10], under A_WIND).
    const float2 wind = airVelocity(float2(x, y) + 0.5);
    u_Alloc[A_PROBE + 9] = asint(wind.x);
    u_Alloc[A_PROBE + 10] = asint(wind.y);
}

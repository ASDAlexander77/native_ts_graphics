// A level's goal, counted once a frame (goal_cs).
// (Included by powder_sandbox.hlsl, after the files before it there.)

// A level's goal: the particles of a material (tool), or the cells of a solid one (only those lit,
// with GOAL_LIT: a lamp's), in the box (brushX0, brushY0) .. (brushX1, brushY1), counted into
// u_Alloc[A_GOAL] once a frame.
#define GOAL_LIT 0x100
groupshared uint s_Goal;

[numthreads(256, 1, 1)]
void goal_cs(uint3 id : SV_GroupThreadID)
{
    const uint tid = id.x;
    if (tid == 0)
    {
        s_Goal = 0;
    }
    GroupMemoryBarrierWithGroupSync();
    const int w = int(g_C.gridW);
    const int h = int(g_C.gridH);
    const int x0 = clamp(int(floor(min(g_C.brushX0, g_C.brushX1))), 0, w - 1);
    const int y0 = clamp(int(floor(min(g_C.brushY0, g_C.brushY1))), 0, h - 1);
    const int x1 = clamp(int(floor(max(g_C.brushX0, g_C.brushX1))), 0, w - 1);
    const int y1 = clamp(int(floor(max(g_C.brushY0, g_C.brushY1))), 0, h - 1);
    const uint bw = uint(x1 - x0 + 1);
    const uint bh = uint(y1 - y0 + 1);
    const uint m = g_C.tool & 0xFF;
    const bool lit = (g_C.tool & GOAL_LIT) != 0;
    // (the particle types: those under the solids', and HYDROGEN's to SEED's)
    const bool particle = m < WALL || (m >= HYDROGEN && m <= SEED);
    uint count = 0;
    for (uint k = tid; k < bw * bh; k += 256)
    {
        const int x = x0 + int(k % bw);
        const int y = y0 + int(k / bw);
        const bool cell = cellMaterial(x, y) == m && (!lit || ((u_GridInt[gi(I_SPARK, cellIndex(x, y))] >> 8) & 0xFF) > 0);
        count += particle ? uint(countOf(m, x, y)) : (cell ? 1u : 0u);
    }
    InterlockedAdd(s_Goal, count);
    GroupMemoryBarrierWithGroupSync();
    if (tid == 0)
    {
        u_Alloc[A_GOAL] = int(s_Goal);
    }
}

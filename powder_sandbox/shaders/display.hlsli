// The display: the grid drawn as a full-screen triangle (display_vs, display_ps), in materials,
// pressure or temperature, with the cursor and the brush's outline.
// (Included by powder_sandbox.hlsl, after the files before it there.)

StructuredBuffer<int> t_GridInt : register(t0);
StructuredBuffer<float> t_GridFloat : register(t1);
StructuredBuffer<uint> t_Cells : register(t2);

void display_vs(uint vertexId : SV_VertexID, out float4 position : SV_Position)
{
    const float2 uv = float2((vertexId << 1) & 2, vertexId & 2);
    position = float4(uv * float2(2, -2) + float2(-1, 1), 0, 1);
}

float sectionAt(uint section, int x, int y)
{
    x = clamp(x, 0, int(g_C.gridW) - 1);
    y = clamp(y, 0, int(g_C.gridH) - 1);
    return float(t_GridInt[section * g_C.stride + cellIndex(x, y)]);
}

int countAt(uint material, int x, int y)
{
    return int(sectionAt(countSection(material), x, y));
}

// An int section, bilinearly between the cell centers.
float sampleSection(float2 g, uint section)
{
    const float2 q = g - 0.5;
    const int2 i0 = int2(floor(q));
    const float2 f = q - float2(i0);
    return lerp(lerp(sectionAt(section, i0.x, i0.y), sectionAt(section, i0.x + 1, i0.y), f.x),
        lerp(sectionAt(section, i0.x, i0.y + 1), sectionAt(section, i0.x + 1, i0.y + 1), f.x), f.y);
}

// A material's particle count, bilinearly between the cell centers.
float sampleCount(float2 g, uint material)
{
    return sampleSection(g, countSection(material));
}

float floatAt(uint section, int x, int y)
{
    x = clamp(x, 0, int(g_C.gridW) - 1);
    y = clamp(y, 0, int(g_C.gridH) - 1);
    return t_GridFloat[section * g_C.stride + cellIndex(x, y)];
}

float sampleFloat(float2 g, uint section)
{
    const float2 q = g - 0.5;
    const int2 i0 = int2(floor(q));
    const float2 f = q - float2(i0);
    return lerp(lerp(floatAt(section, i0.x, i0.y), floatAt(section, i0.x + 1, i0.y), f.x),
        lerp(floatAt(section, i0.x, i0.y + 1), floatAt(section, i0.x + 1, i0.y + 1), f.x), f.y);
}

float3 materialColor(uint m)
{
    switch (m)
    {
    case WATER: return float3(0.12, 0.38, 0.9);
    case OIL: return float3(0.72, 0.5, 0.12);
    case SAND: return float3(0.86, 0.74, 0.44);
    case FIRE: return float3(1.0, 0.5, 0.1);
    case SMOKE: return float3(0.4, 0.4, 0.42);
    case STEAM: return float3(0.85, 0.88, 0.92);
    case NEUTRON: return float3(0.5, 1.0, 0.4);
    case LAVA: return float3(0.55, 0.12, 0.03);
    case ACID: return float3(0.45, 0.92, 0.18);
    case SALT: return float3(0.92, 0.92, 0.95);
    case GUNPOWDER: return float3(0.2, 0.2, 0.22);
    case HONEY: return float3(0.85, 0.55, 0.1);
    case PETROL: return float3(0.95, 0.88, 0.5);
    case EMBER: return float3(1.0, 0.55, 0.15);
    case HYDROGEN: return float3(0.85, 0.92, 1.0);
    case OXYGEN: return float3(0.55, 0.72, 1.0);
    case NEON: return float3(0.85, 0.45, 0.4);
    case THERMITE: return float3(0.5, 0.32, 0.28);
    case NITRO: return float3(0.86, 0.9, 0.62);
    case C4: return float3(0.84, 0.8, 0.68);
    case COAL: return float3(0.13, 0.12, 0.12);
    case FUSE: return float3(0.42, 0.3, 0.2);
    case SEED: return float3(0.55, 0.45, 0.2);
    case CLONE: return float3(0.85, 0.85, 0.3);
    case BLACK_HOLE: return float3(0.03, 0.0, 0.05);
    case WHITE_HOLE: return float3(0.95, 0.95, 1.0);
    case SPONGE: return float3(0.9, 0.85, 0.45);
    case PLANT: return float3(0.2, 0.6, 0.15);
    case SWITCH: return float3(0.45, 0.2, 0.2);
    case DETECTOR: return float3(0.75, 0.3, 0.6);
    case HEATER: return float3(0.5, 0.3, 0.25);
    case WALL: return float3(0.42, 0.42, 0.45);
    case GLASS: return float3(0.6, 0.85, 0.92);
    case WOOD: return float3(0.45, 0.28, 0.12);
    case URANIUM: return float3(0.25, 0.65, 0.2);
    case EMITTER: return float3(0.62, 0.22, 0.62);
    case ICE: return float3(0.75, 0.92, 1.0);
    case STONE: return float3(0.33, 0.3, 0.29);
    case METAL: return float3(0.6, 0.64, 0.7);
    case FAN: return float3(0.3, 0.5, 0.58);
    case BLOCK: return float3(0.72, 0.52, 0.3);
    case BATTERY: return float3(0.22, 0.22, 0.26);
    case LAMP: return float3(0.4, 0.37, 0.28);
    }
    return float3(0.0, 0.0, 0.0);
}

// Cold blue, ambient black, then red, yellow, white.
float3 temperatureRamp(float t)
{
    if (t < AMBIENT)
    {
        return float3(0.1, 0.3, 1.0) * saturate((AMBIENT - t) / 120.0);
    }
    const float x = saturate(log2(1.0 + (t - AMBIENT) / 40.0) / 5.0);
    return float3(saturate(x * 2.0), saturate(x * 2.0 - 0.7), saturate(x * 3.0 - 2.0));
}

#define SHIMMER 0.3

float4 display_ps(float4 position : SV_Position) : SV_Target
{
    float2 g = (position.xy - float2(g_C.viewX, g_C.viewY)) / g_C.cellPixels;
    if (any(g < 0.0) || g.x >= float(g_C.gridW) || g.y >= float(g_C.gridH))
    {
        return float4(0.02, 0.02, 0.03, 1.0);
    }
    // Hot air shimmers: what's seen through it wavers (up to SHIMMER cells), the hotter the more.
    {
        const int2 a = int2(floor(g));
        const float hot = isSolidMaterial(t_Cells[cellIndex(a.x, a.y)] & 0xFF) ? 0.0 : saturate((floatAt(F_TCELL, a.x, a.y) - 60.0) / 300.0);
        g += SHIMMER * hot * float2(sin(g.y * 1.9 + g_C.time * 11.0), sin(g.x * 1.3 - g_C.time * 8.0 + g.y * 0.7));
        g = clamp(g, 0.001, float2(g_C.gridW, g_C.gridH) - 0.001);
    }
    const int2 c = int2(floor(g));
    const uint cell = t_Cells[cellIndex(c.x, c.y)];
    const uint m = cell & 0xFF;
    const float t = floatAt(F_TCELL, c.x, c.y);
    float3 color = float3(0.05, 0.06, 0.08);

    // Liquids and sand: a smooth surface through the counts.
    const float water = sampleCount(g, WATER);
    const float oil = sampleCount(g, OIL);
    const float sand = sampleCount(g, SAND);
    const float lava = sampleCount(g, LAVA);
    const float acid = sampleCount(g, ACID);
    const float salt = sampleCount(g, SALT);
    const float gunpowder = sampleCount(g, GUNPOWDER);
    const float honey = sampleCount(g, HONEY);
    const float petrol = sampleCount(g, PETROL);
    const float thermite = sampleCount(g, THERMITE);
    const float nitro = sampleCount(g, NITRO);
    const float seed = sampleCount(g, SEED);
    const float total = water + oil + sand + lava + acid + salt + gunpowder + honey + petrol + thermite + nitro + seed;
    if (total > 0.01)
    {
        // Salt water a greener blue, the saltier the more (fully at 40%: seawater's a tenth of that).
        const float salinity = saturate(2.5 * sampleSection(g, I_SALT) / SALT_SCALE / max(water, 0.5));
        const float3 waterColor = lerp(materialColor(WATER), float3(0.1, 0.55, 0.62), salinity);
        float3 liquid = (water * waterColor + oil * materialColor(OIL) + sand * materialColor(SAND)
            + lava * materialColor(LAVA) + acid * materialColor(ACID) + salt * materialColor(SALT)
            + gunpowder * materialColor(GUNPOWDER) + honey * materialColor(HONEY) + petrol * materialColor(PETROL)
            + thermite * materialColor(THERMITE) + nitro * materialColor(NITRO) + seed * materialColor(SEED)) / total;
        if (sand + salt + gunpowder + thermite + seed > water + oil + lava + acid + honey + petrol + nitro)
        {
            // Grains
            const uint2 grain = uint2(g * 3.0);
            liquid *= 0.85 + 0.3 * random01(grain.x * 7919u + grain.y * 104729u);
        }
        color = lerp(color, liquid, smoothstep(0.8, 2.0, total));
    }

    // Gases over them.
    const float smoke = sampleCount(g, SMOKE);
    const float steam = sampleCount(g, STEAM);
    const float fire = sampleCount(g, FIRE);
    color = lerp(color, materialColor(SMOKE), saturate(smoke * 0.35));
    color = lerp(color, materialColor(STEAM), saturate(steam * 0.3));
    // Hydrogen and oxygen faint; neon faint, but shining where a current runs through it.
    color = lerp(color, materialColor(HYDROGEN), saturate(sampleCount(g, HYDROGEN) * 0.08));
    color = lerp(color, materialColor(OXYGEN), saturate(sampleCount(g, OXYGEN) * 0.12));
    const float neon = sampleCount(g, NEON);
    color = lerp(color, materialColor(NEON), saturate(neon * 0.15));
    color += NEON_COLOR * saturate(neon) * saturate(float((int(sectionAt(I_SPARK, c.x, c.y)) >> 8) & 0xFF) / 10.0);
    const float flicker = 0.8 + 0.2 * sin(g_C.time * 23.0 + g.x * 1.7 + g.y * 2.3);
    color += materialColor(FIRE) * saturate(fire * 0.6) * flicker + float3(1.0, 0.85, 0.4) * saturate(fire * 0.25 - 0.3);

    if (countAt(NEUTRON, c.x, c.y) > 0 && length(frac(g) - 0.5) < 0.35)
    {
        color = lerp(color, materialColor(NEUTRON), 0.85);
    }
    // Embers: bright flickering specks, dimming as they cool.
    const float ember = sampleCount(g, EMBER);
    color += materialColor(EMBER) * saturate(ember * 2.0) * (0.75 + 0.25 * sin(g_C.time * 37.0 + g.x * 5.0 + g.y * 3.0));

    if (isSolidMaterial(m))
    {
        const float2 f = frac(g);
        const float edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
        float3 solid = materialColor(m);
        if (m == GLASS)
        {
            color = lerp(color, solid, 0.45) + 0.15 * (1.0 - smoothstep(0.0, 0.2, edge));
        }
        else if (m == ICE)
        {
            // Frosted: mostly opaque, lighter at the cells' edges.
            color = lerp(color, solid, 0.75) + 0.1 * (1.0 - smoothstep(0.0, 0.25, edge));
        }
        else
        {
            if (m == WALL)
            {
                solid *= 0.9 + 0.1 * random01(uint(c.x) * 31u + uint(c.y) * 17u);
            }
            else if (m == WOOD)
            {
                solid *= 0.85 + 0.15 * sin(g.y * 9.0 + sin(g.x * 1.3) * 2.0);
                if ((cell & BURNING) != 0)
                {
                    solid = lerp(solid, float3(1.0, 0.4, 0.08), 0.6 + 0.3 * sin(g_C.time * 17.0 + c.x * 3.1 + c.y * 1.9));
                }
            }
            else if (m == URANIUM)
            {
                solid *= 0.8 + 0.4 * saturate((t - AMBIENT) / 300.0);
            }
            else if (m == METAL)
            {
                // Brushed: faint streaks along x.
                solid *= 0.9 + 0.12 * random01(uint(c.y) * 7919u + uint(g.x * 0.25) * 31u);
            }
            else if (m == STONE)
            {
                solid *= 0.8 + 0.3 * random01(uint(c.x) * 131u + uint(c.y) * 977u);
            }
            else if (m == EMITTER)
            {
                solid = length(f - 0.5) < 0.22 ? materialColor((cell >> 8) & 0xFF) : solid;
            }
            else if (m == BLOCK)
            {
                // A shade a body, planks across it.
                solid *= 0.85 + 0.05 * float((cell >> 8) & 3u) + 0.08 * step(0.5, frac(g.y * 0.34));
            }
            else if (m == CLONE)
            {
                // A frame, its learned material in the middle.
                const uint learned = (cell >> 8) & 0xFF;
                solid = learned != 0 && length(f - 0.5) < 0.25 ? materialColor(learned) : solid * (0.8 + 0.2 * step(0.25, edge));
            }
            else if (m == BLACK_HOLE || m == WHITE_HOLE)
            {
                // A swirl.
                const float2 d = f - 0.5;
                solid = lerp(solid, m == BLACK_HOLE ? float3(0.35, 0.1, 0.5) : float3(0.6, 0.7, 1.0),
                    0.5 + 0.5 * sin(atan2(d.y, d.x) * 3.0 + length(d) * 12.0 - g_C.time * 6.0));
            }
            else if (m == SPONGE)
            {
                // Holes; wetter, darker and bluer.
                const float wet = float((cell >> 8) & 0xFF) / float(SPONGE_HOLD);
                solid *= 0.8 + 0.3 * step(0.3, random01(uint(g.x * 3.0) * 7919u + uint(g.y * 3.0) * 104729u));
                solid = lerp(solid, float3(0.35, 0.45, 0.6), 0.6 * wet);
            }
            else if (m == PLANT)
            {
                // Leaves, a lighter green where it still has energy to grow; burning, orange.
                solid *= 0.8 + 0.35 * random01(uint(c.x) * 131u + uint(c.y) * 977u);
                solid = lerp(solid, float3(0.45, 0.85, 0.3), saturate(float((cell >> 8) & 0xFF) / 4.0) * 0.5);
                if ((cell & BURNING) != 0)
                {
                    solid = lerp(solid, float3(1.0, 0.45, 0.1), 0.6 + 0.3 * sin(g_C.time * 17.0 + c.x * 3.1 + c.y * 1.9));
                }
            }
            else if (m == SWITCH)
            {
                // Red when off, green when on.
                solid = (cell & SWITCH_ON) != 0 ? float3(0.2, 0.6, 0.25) : solid;
                solid *= 0.85 + 0.15 * step(0.2, edge);
            }
            else if (m == DETECTOR)
            {
                solid *= 0.8 + 0.3 * step(0.5, frac((g.x - g.y) * 0.5));
            }
            else if (m == HEATER)
            {
                // Coils.
                solid *= 0.75 + 0.35 * step(0.5, frac(g.y * 0.5));
            }
            else if (m == C4)
            {
                solid *= 0.92 + 0.12 * random01(uint(c.x) * 53u + uint(c.y) * 401u);
            }
            else if (m == COAL || m == FUSE)
            {
                // Coal lumpy, a fuse's cord striped; burning, an orange glow flickering through.
                solid *= m == COAL ? 0.7 + 0.6 * random01(uint(c.x) * 7u + uint(c.y) * 1031u) : 0.8 + 0.3 * step(0.5, frac((g.x + g.y) * 0.5));
                if ((cell & BURNING) != 0)
                {
                    solid = lerp(solid, float3(1.0, 0.45, 0.1), (m == FUSE ? 0.85 : 0.55) + 0.3 * sin(g_C.time * 13.0 + c.x * 2.3 + c.y * 3.7));
                }
            }
            else if (m == BATTERY)
            {
                // A cell, its top a copper band.
                solid = frac(g.y * 0.25) < 0.3 ? float3(0.75, 0.45, 0.2) : solid;
            }
            else if (m == LAMP)
            {
                // Lit: warm white, brighter at the cells' middles.
                const float lit = saturate(float((int(sectionAt(I_SPARK, c.x, c.y)) >> 8) & 0xFF) / 10.0);
                solid = lerp(solid, float3(1.0, 0.92, 0.7) * (0.9 + 0.2 * (1.0 - 2.0 * edge)), lit);
            }
            else if (m == FAN)
            {
                // Stripes moving the way it blows.
                const uint dir = (cell >> 8) & 3u;
                const float along = dir == 0 ? g.x : (dir == 1 ? g.y : (dir == 2 ? -g.x : -g.y));
                solid *= 0.75 + 0.35 * step(0.5, frac(along * 0.5 - g_C.time * 3.0));
            }
            color = solid;
        }
    }

    color += heatColor(t);
    // A spark running through a conductor: blue-white, fading as it rests.
    {
        const int phase = int(sectionAt(I_SPARK, c.x, c.y)) & 0xFF;
        if (phase >= SPARK_LIVE && countAt(NEON, c.x, c.y) == 0)
        {
            color = lerp(color, float3(0.8, 0.92, 1.0), phase <= SPARK_LIVE + 1 ? 0.9 : 0.6 * float(SPARK_LIVE + SPARK_REST + 1 - phase) / float(SPARK_REST));
        }
    }
    // The glow round what's bright.
    color += GLOW_STRENGTH * float3(sampleSection(g, I_GLOW), sampleSection(g, I_GLOW + 1), sampleSection(g, I_GLOW + 2)) / GLOW_SCALE;

    if (g_C.overlay == 1)
    {
        // Pressure, in cells of water depth: blue below zero, then up to red at a third of the grid.
        const float p = sampleFloat(g, F_P) / (g_C.dt * g_C.gravity);
        const float x = saturate(p / (float(g_C.gridH) / 3.0));
        const float3 ramp = p < 0.0 ? float3(0.2, 0.4, 1.0) * saturate(-p / 4.0) : float3(x, 0.25 * (1.0 - abs(2.0 * x - 1.0)) + 0.1 * x, 1.0 - x) * step(0.001, x);
        color = lerp(color * 0.35, ramp, total > 0.5 ? 0.85 : 0.0);
    }
    else if (g_C.overlay == 2)
    {
        color = lerp(color * 0.3, temperatureRamp(sampleFloat(g, F_TCELL)), 0.8);
    }

    // The attraction point: a ring round it, white with a dark rim.
    if (gravityMode() == GRAVITY_POINT)
    {
        const float ring = abs(length(g - float2(g_C.gravityX, g_C.gravityY)) * g_C.cellPixels - 7.0);
        if (ring < 1.0)
        {
            color = lerp(color, float3(1.0, 1.0, 1.0), 0.9);
        }
        else if (ring < 2.5)
        {
            color *= 0.25;
        }
    }

    // The cursor: the edge of the area the brush paints, a white line with a dark rim either side.
    const uint cursorMode = (g_C.brushShape >> 4) & 0xF;
    if (cursorMode == 3)
    {
        // Inspecting: the outline of the cell under the pointer, and a crosshair through it.
        const float2 pointer = float2(g_C.probeX, g_C.probeY);
        const float2 cell = floor(pointer);
        const float2 fromCell = max(cell - g, g - cell - 1.0) * g_C.cellPixels;
        const float outline = abs(max(fromCell.x, fromCell.y));
        const float2 d = abs(g - pointer) * g_C.cellPixels;
        const bool cross = min(d.x, d.y) < 0.75 && max(d.x, d.y) > 6.0 && max(d.x, d.y) < 18.0;
        if (outline < 0.75 || cross)
        {
            color = lerp(color, float3(1.0, 1.0, 1.0), 0.9);
        }
        else if (outline < 2.0)
        {
            color *= 0.25;
        }
    }
    else if (cursorMode != 0)
    {
        const float edge = abs(brushDistance(g, cursorMode, g_C.brushShape & 0xF, float2(g_C.cursorX0, g_C.cursorY0),
            float2(g_C.probeX, g_C.probeY), g_C.brushRadius)) * g_C.cellPixels;
        if (edge < 0.75)
        {
            color = lerp(color, float3(1.0, 1.0, 1.0), 0.9);
        }
        else if (edge < 2.0)
        {
            color *= 0.25;
        }
    }
    return float4(color, 1.0);
}

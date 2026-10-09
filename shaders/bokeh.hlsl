//--------------------------------------------------------------------------------------
// Bokeh: depth of field rendered with point sprites
//
// Advanced Technology Group (ATG)
// Copyright (C) Microsoft Corporation. All rights reserved.
//--------------------------------------------------------------------------------------

// The Xbox ATG Bokeh12 sample's shaders (Shaders/*.hlsl, shadersettings.h) on Donut's bindings,
// one entry point each (the energy weights' compute shader is bokeh_energy.hlsl, the scene's
// bokeh_scene.hlsl). The root signatures' descriptor tables become each pass's own binding set
// (see bokeh.ts); what changed otherwise is marked "Port:".

// --- shadersettings.h ------------------------------------------------------------------------

// This is the scale of the initial downsample of the original color and depth buffers
// into the single RGBZ buffer
// This must be 2
#define FIRST_DOWNSAMPLE    2

// This defines how many individual weights we recognise. Usually normalisation weights
// vary a lot when a sprite is tiny, but then they follow a more predictable area rule.
// For example, for a round iris texture this rule is 1/(PI * R^2).
// However, for unusual iris textures the area rule can't be derived in closed form so
// our numerical weight calculation is still needed.
// This is why this is set to 64 and not to 8. Eight would be enough for round irises.
// Note that the whole normalisation effort isn't needed for far range blur, only for
// near range blur.
#define NUM_RADII_WEIGHTS   64

// --- Bokeh.hlsli -----------------------------------------------------------------------------
//
// The approach is two fold.
//
// First it uses scattering instead of gather to simulate the blur appearing in the out-of-focus
// parts of the image. The simple idea is to output a point sprite per pixel. Each point sprite
// has a diameter of the circle of confusion at the source pixel.
//
// Second is the splitting of the image into 3 layers to make sure occlusion is correct between
// the in-focus and out-of-focus parts of the image.
//
// One artefact that is not solved by this approach is missing self occlusion in the near range
// layer (when pixels in the near range image don't always correctly occlude pixels in the same
// range). This doesn't happen between the ranges and in the far range.

// parameters for bokeh
// Port: the sample's packoffsets are the natural packing of these members, written out here.
cbuffer bokeh : register(b0)
{
    float       g_fMaxCoCRadiusNear;        // c0.x
    float       g_fFocusLength;             // c0.y
    float       g_fFocalPlane;              // c0.z
    float       g_fFNumber;                 // c0.w
    float2      g_depthBufferSize;          // c1.x
    float2      g_dofTexSize;               // c1.z
    float2      g_screenSize;               // c2.x
    float       g_fMaxCoCRadiusFar;         // c2.z
    float       g_fIrisTextureOffset;       // c2.w
    float4      g_viewports[ 6 ];           // c3: 0 -- near, 1 -- far, 2 - nearsmall, 3 - farsmall, etc
    float2      g_switchover1;              // c9.x
    float2      g_switchover2;              // c9.z
    float       g_initialEnergyScale;       // c10.x
    float3      g_pad;
    float4x4    g_mInvProj;                 // c11
};

// iris texture blend weights based on the sprite size
// Port: a 64 x 1 Texture2D (the sample's is a Texture1D).
Texture2D   energies : register( t4 );

Texture2D   t0 : register( t0 );
Texture2D   t1 : register( t1 );
Texture2D   t2 : register( t2 );
Texture2D   t3 : register( t3 );

SamplerState s0 : register( s0 );


// used to pass interpolators for full screen quad rendering
struct PSSceneIn
{
    float2 tex : TEXCOORD0;
    float4 pos : SV_Position;
};

struct GSSceneInPoint
{
    float2  pos : POS;
    float3  clr : TEXCOORD1;
    float   weight : WEIGHT;
    float   radius : RADIUS;
    uint    viewportIndex : VPINDEX;
};

struct PSSceneInPoint
{
    float4  pos : SV_Position;
    uint    viewportIndex : SV_ViewportArrayIndex;
    float2  uv : TEXCOORD0;
    float3  clr : TEXCOORD1;
    float   weight : WEIGHT;
};

struct BokehInfo
{
    float    fCoCRadius;            // circle of confusion radius
    float    fDepthDifference;    // difference between the focus plane and depth
    float    fDepth;                // linear view space depth value
};



// calculates the size of CoC given the linear depth of a pixel.
// it uses a thin lens formula from photography so you can control DOF blur as you would
// on a camera -- by changing the aperture and focus length.
// replace this if you don't like the look of this.
float CalculateCoC( in float fDepth, out float fDepthDifference )
{
    fDepthDifference = fDepth - g_fFocalPlane;

    // thin lens
    const float var = abs( fDepthDifference ) / fDepth;
    const float cnst = g_fFocusLength * g_fFocusLength / (g_fFNumber * (g_fFocalPlane - g_fFocusLength));    // TODO: calculate on the CPU
    const float cocMetersRadius = 0.5f * var * cnst;                  // coc radius in meters
    const float cocRelativeToFilm = cocMetersRadius / 0.035f;         // size relative to 35mm sensor
    const float cocRadiusInPixels = g_depthBufferSize.x * cocRelativeToFilm;

    return min( (fDepthDifference < 0) ? g_fMaxCoCRadiusNear : g_fMaxCoCRadiusFar, cocRadiusInPixels );
}

// given a screen position, and using a colour and a depth buffer, calculate the DOF parameters
BokehInfo GetBokehInfo( uint2 pos )
{
    BokehInfo    i;

    float4    fDepthSample;        // view space coord
    float     fTexDepth;            // depth value from the depth buffer
    float2    fInvSize;            // TODO: precalc - inverse screen size

    fInvSize = 1.f / float2(g_screenSize.xy);
    const float2 fTexCoord = (float2(pos)+0.5f) * fInvSize;        // point to the centre of the 2x2 block for depth calculation
    const float2 fNDC = float2(2.f * fTexCoord.x - 1, 1 - 2.f * fTexCoord.y);

    fTexDepth = t2.Load(uint3(pos, 0)).x;

    fDepthSample = mul(float4(fNDC, fTexDepth, 1), g_mInvProj);

    i.fDepth = fDepthSample.z / fDepthSample.w;

    i.fCoCRadius = CalculateCoC(i.fDepth, i.fDepthDifference);

    return i;
}

// --- QuadVS.hlsl ----------------------------------------------------------------------------

static float4 s_positions[3] =
{
    float4(-1.0f, 1.0f, 0.0f, 1.0f),
    float4(3.0f,  1.0f, 0.0f, 1.0f),
    float4(-1.0f, -3.0f, 0.0f, 1.0f),
};

static float2 s_texcoords[3] =
{
    float2(0.0f, 0.0f),
    float2(2.0f, 0.0f),
    float2(0.0f, 2.0f),
};

// output a quad
PSSceneIn quad_vs(uint index : SV_VertexID)
{
    PSSceneIn output;
    output.pos = s_positions[index % 3];
    output.tex = s_texcoords[index % 3];

    return output;
}

// --- CreateRGBZPS.hlsl ----------------------------------------------------------------------

// this creates a full screen version of the RGBZ texture from a source colour and depth texture
// note that we only consume a quarter res version of this texture in point sprites generation
// and we consume this in the last step.
float4 create_rgbz_ps(in float2 dummy : TEXCOORD0, in float4 p : SV_Position) : SV_Target
{
    uint2   pos = uint2(p.xy);
    float3  color = t0.Load(uint3(pos, 0)).xyz;

    const BokehInfo    i = GetBokehInfo(pos);

    return float4(color, i.fDepth);
}

// --- DownsampleRGBZPS.hlsl ------------------------------------------------------------------

// downsample the RGBZ texture
float4 downsample_rgbz_ps(in float2 dummy : TEXCOORD0, in float4 p : SV_Position) : SV_Target
{
    float3  color = t0.Sample(s0, dummy).xyz;
    float4  depths = t0.GatherAlpha(s0, dummy);
    float   depth = min(depths.x, min(depths.y, min(depths.z, depths.w)));

    return float4(color, depth);
}

// --- QuadPointVS.hlsl -----------------------------------------------------------------------

// the runtime requires a vertex shader at all times, and we don't need it to render point sprites, so we have to use an empty VS
// Port: it outputs a position, unused, which Vulkan's geometry shader input needs.
float4 quad_point_vs(uint index : SV_VertexID) : SV_Position
{
    return float4(0, 0, 0, 1);
}

// --- QuadPointGS.hlsl, QuadPointFastGS.hlsl (OPTIMISE=1) -------------------------------------

// This function takes the screen position in source screen coordinates, loads the RGBZ for this point
// then calculates CoC and scale and the correct output resolution and outputs all that for further
// expansion into a sprite.
GSSceneInPoint GenerateSpritePointFromXY(uint xx, uint yy)
{
    BokehInfo    i;

    float4    rgbz = t0.Load(uint3(xx, yy, 0));

    float3 clr = rgbz.xyz;

    i.fCoCRadius = CalculateCoC(rgbz.w, i.fDepthDifference);

    GSSceneInPoint output;

    output.clr.xyz = clr.xyz;

    output.radius = i.fCoCRadius;

    // note on the 0.5f here
    // +0.5f when using downsampled source to make sure geometry of 0.5f size crosses pixel centres
    // +0.0f aligns texels to pixels but the sprites don't cross pixel centres at size 0.5f. it's probably not such a big deal
    // if we were working in full res, but at half res 1 pixel sprites are actually 2x2 when blended back so we can't afford to lose them
    // so we actually offset the geometry to cross pixel centre by 0.5f and also offset texture coordinate back

    float2 fSpriteOrg = (float2(xx, yy) + 0.5f) / float2(g_screenSize.xy / FIRST_DOWNSAMPLE);
    output.pos = float2(2.f * fSpriteOrg.x - 1, 1 - 2.f * fSpriteOrg.y);

    float energyScaler = g_initialEnergyScale;

    // first target is quarter res
    output.radius /= 2;

    // too large? put into the next sized viewport, adjust parameters accordingly
    uint baseVp = 0;

    const uint nearOrFarIndex = (i.fDepthDifference >= 0) ? 1 : 0;        // either near (0) or far (1)

    if (output.radius >= g_switchover1[nearOrFarIndex])
    {
        baseVp = 2;

        output.radius /= 2;
        energyScaler /= 4;  // correctly preserved energy is /4 (because the area decreases as 1/4 give or take)
                            // we can use /3 because upsampling will lose some and for more dramatic
                            // defocused highlight but that corrupts the blend interface
    }

    if (output.radius >= g_switchover2[nearOrFarIndex])
    {
        baseVp = 4;

        output.radius /= 2;
        energyScaler /= 4;
    }

    // this makes a fundamental difference, probably best picked based on looks
    // the advantage of rounding is weights can be "exactly" precalculated at least
    // if we don't round we can't predict what happens to the pixel inbetween integer pixel sizes
    // unfortunately, at integer radii, we get noticeable quantisation in sizes
    if (i.fDepthDifference < 0)
    {
        // near interface is most troublesome, don't start blending until it reaches at least 2x2 pixels in size,
        // something a quarter res target can easily handle
        if (output.radius < 1.0f)
            output.radius = 0;
    }

    output.radius = round(output.radius * 2) / 2;
    float d = output.radius;    // omit *2 for diameter, scale the coeff instead

    // we take 1 pixel and spread it's energy across a larger area. to preserve the energy
    // we need to calculate the weight reduction which cannot be established exactly and varies
    // with the shape of the iris.
    // note that energy preservation doesn't matter for the far layer -- we need it for the near
    // layer to correctly produce defocused blurs over in-focus and far layers
    // if you're only doing the far layer, you can set it to 1
    // Port: energies is a Texture2D.
    float   energy = (d < (NUM_RADII_WEIGHTS / 2)) ?                          // this gens faster code than an if() statement (movc vs a branch)
        1.267f :                                            // this is 4/PI which in limit is the right weight for a round iris
        energies.Load(uint3(round(d * 2), 0, 0)).x;

    output.weight = energy * energyScaler / (d * d);

    // dispatch the point to the right viewport
    output.viewportIndex = baseVp + nearOrFarIndex;

    return output;
}


// This is a workhorse of the sprite expansion function. It will decide whether the sprite is big enough and it will expand it
// into a triangle sprite.
void EmitSpriteIfBigEnough(GSSceneInPoint pt, inout TriangleStream<PSSceneInPoint> spriteStream, float3 useThisColorFor2x2)
{
    static const float4 posuv[3] =
    {
        float4(-1, -1, 0,  1),
        float4(-1,  3, 0, -1),
        float4(3, -1, 2,  1),
    };

    const float fBlurRadiusInPixels = pt.radius;

    // this will govern how much blend overlap there is between the layers
    if (fBlurRadiusInPixels >= 0.5f)
    {
        const uint   vp = pt.viewportIndex;
        const float3 clr = (vp >= 2) ? useThisColorFor2x2 : pt.clr.xyz;
        const float2 org = pt.pos.xy;
        const float  weight = pt.weight;

        for (int i = 0; i < 3; i++)
        {
            PSSceneInPoint output;

            output.pos = float4((posuv[i].xy * fBlurRadiusInPixels) / float2(g_viewports[vp].zw) + org, 0, 1);
            output.clr = clr;
            output.weight = weight;
            output.uv = posuv[i].zw + g_fIrisTextureOffset;       // iris texture size here. this is to match texels to pixels with 1x1 sprites
            output.viewportIndex = vp;

            spriteStream.Append(output);
        }

        spriteStream.RestartStrip();
    }
}

// triangles are 0.5 ms faster (1.7 vs 2.4ms with quads)!

// This converts a point into a sprite
// It routes the viewport index to GS output so that the geometry ends up in the correct viewport
// There is a point primitive for each pixel of the source RGBZ texture, this shader reads the
// point primitive and the texel value, calculates the CoC, then normalisation factor, then
// decides which viewport to output the sprite to and whether to output one or four sprites, then
// finally expands the point into a sprite
// Port: its input is quad_point_vs's position (the sample's is an empty struct).
[maxvertexcount(12)]  // we output from 1 to 4 triangle sprites so we need space for up to 12 output vertices
void quad_point_gs(point float4 p[1] : SV_Position,
    uint inst0 : SV_PrimitiveID,        // VertexID == PrimitiveID for point lists
    inout TriangleStream<PSSceneInPoint> spriteStream)
{
    // accessing data in 4x1 blocks is slightly quicker than in 2x2 blocks
    // for optimising the number of quads we have to access 2x2 blocks
    // because we need to see the difference in Y as well as in X between the
    // source pixels
    //
    // the difference is a constant 0.015 ms
    //

#if OPTIMISE
#define  READ2x2
#endif

#ifdef READ2x2
    const uint topLeftX = 2 * ((inst0) % floor(g_screenSize.x / (FIRST_DOWNSAMPLE * 2.0)));
    const uint topLeftY = 2 * ((inst0) / floor(g_screenSize.x / (FIRST_DOWNSAMPLE * 2.0)));
#else
    const uint    topLeftX = (inst0 * 4) % floor(g_screenSize.x / (FIRST_DOWNSAMPLE));
    const uint    topLeftY = (inst0 * 4) / floor(g_screenSize.x / (FIRST_DOWNSAMPLE));
#endif

    GSSceneInPoint  pt[4];

    uint i;
    for (i = 0; i < 4; ++i)
    {
#ifdef  READ2x2
        const uint    xx = topLeftX + (i % 2);
        const uint    yy = topLeftY + (i / 2);
#else
        const uint    xx = topLeftX + i;
        const uint    yy = topLeftY;
#endif

        pt[i] = GenerateSpritePointFromXY(xx, yy);
    }

    // now see if we can output only 1 sprite for this saves us tons of time if we can do it

    bool bOutputOne = true;

    if ((pt[0].viewportIndex != pt[1].viewportIndex) ||
        (pt[0].viewportIndex != pt[2].viewportIndex) ||
        (pt[0].viewportIndex != pt[3].viewportIndex))
    {
        bOutputOne = false;
    }

    const float radiusThreshold = 1;
    const float colorThreshold = 0.2f;

    if (abs(pt[0].radius - pt[1].radius) > radiusThreshold ||
        abs(pt[0].radius - pt[2].radius) > radiusThreshold ||
        abs(pt[0].radius - pt[3].radius) > radiusThreshold)
    {
        bOutputOne = false;
    }

    // TODO: replace with length square
    if (distance(pt[0].clr, pt[1].clr) > colorThreshold ||
        distance(pt[0].clr, pt[2].clr) > colorThreshold ||
        distance(pt[0].clr, pt[3].clr) > colorThreshold)
    {
        bOutputOne = false;
    }

    // causes artefacts near the boundary so don't attempt to optimise near the boundary
    if (pt[0].radius < 4.f)
        bOutputOne = false;

#if !OPTIMISE
    bOutputOne = false;
#endif

    if (bOutputOne)
    {
        // TODO: properly merge, this is a quick hack
        GSSceneInPoint mergedSprite;

        mergedSprite.clr = 0.25f * (pt[0].clr + pt[1].clr + pt[2].clr + pt[3].clr);
        mergedSprite.weight = 0.25f * (pt[0].weight + pt[1].weight + pt[2].weight + pt[3].weight) * 4; // TODO: max weight?
        mergedSprite.radius = 0.25f * (pt[0].radius + pt[1].radius + pt[2].radius + pt[3].radius);
        mergedSprite.pos = 0.25f * (pt[0].pos + pt[1].pos + pt[2].pos + pt[3].pos);
        mergedSprite.viewportIndex = pt[0].viewportIndex;

        EmitSpriteIfBigEnough(mergedSprite, spriteStream, mergedSprite.clr);
    }
    else
    {
        // this colour will only be used if a sprite goes into a smaller render target
        // TODO: try picking the brightest clr here
        float3 averageColor = 0.25f * (pt[0].clr + pt[1].clr + pt[2].clr + pt[3].clr);
        for (i = 0; i < 4; ++i)
        {
            EmitSpriteIfBigEnough(pt[i], spriteStream, averageColor);
        }
    }
}

// --- QuadPointPS.hlsl -----------------------------------------------------------------------

// the last step -- output alpha premultiplied colour using this trivial pixel shader
float4 quad_point_ps(PSSceneInPoint input) : SV_Target
{
    float iris = t1.Sample(s0, input.uv).x;

    float w = input.weight * iris;
    if (w <= 0)
    {
        discard;
    }

    return float4(input.clr.xyz, 1) * w;
}

// --- RecombinePS.hlsl -----------------------------------------------------------------------

// after all the layers are generated, this step combines them with the in-focus image for the final image
// in-focus image occludes far layer and the near layer occludes both in-focus and far layers
float4 recombine_ps(PSSceneIn input) : SV_Target
{
    // full resolution in-focus colour and linear depth
    float4 rgbz = t3.Load(uint3(input.tex * g_screenSize, 0));

    BokehInfo    i;
    i.fCoCRadius = CalculateCoC(rgbz.w, i.fDepthDifference);

    float4 c = float4(rgbz.xyz, 1);

    // in focus area totally obscures far range and is always weight = 1
    // this doesn't have to be exclusive, it's possible to blend one into another over a range of CoC values
    if (i.fCoCRadius > 1.0f &&
        i.fDepthDifference > 0)
    {
        float2  texUvFar = ((input.tex * g_viewports[1].zw) + g_viewports[1].xy) / g_dofTexSize;
        float2  texUvFar2 = ((input.tex * g_viewports[3].zw) + g_viewports[3].xy) / g_dofTexSize;
        float2  texUvFar4 = ((input.tex * g_viewports[5].zw) + g_viewports[5].xy) / g_dofTexSize;

        float4  clrFar = t0.Sample(s0, texUvFar);
        float4  clrFar2 = t0.Sample(s0, texUvFar2);
        float4  clrFar4 = t0.Sample(s0, texUvFar4);

        float4 far = clrFar + clrFar2 + clrFar4;

        c = lerp(c, far, min(1, i.fCoCRadius - 1));   // a small blend over to cover the transition

                                                      // normalize so the image doesn't get brighter or dimmer
        if (c.w > 0.00001f)
            c.xyz /= c.w;

        c.w = 1;
    }

    // blend in the near layer
    float2  texUvNear = ((input.tex * g_viewports[0].zw) + g_viewports[0].xy) / g_dofTexSize;
    float2  texUvNear2 = ((input.tex * g_viewports[2].zw) + g_viewports[2].xy) / g_dofTexSize;
    float2  texUvNear4 = ((input.tex * g_viewports[4].zw) + g_viewports[4].xy) / g_dofTexSize;

    float4  clrNear = t0.Sample(s0, texUvNear);
    float4  clrNear2 = t0.Sample(s0, texUvNear2);
    float4  clrNear4 = t0.Sample(s0, texUvNear4);

    float4 near = clrNear + clrNear2 + clrNear4;

    if (near.w > 0)
    {
        float occlusion = 0;

        if (i.fCoCRadius >= 1.0f &&
            i.fDepthDifference < 0)
        {
            float nearToInFocusTransition = min(1, (i.fCoCRadius - 1));
            occlusion = max(occlusion, nearToInFocusTransition);   // a small blend over to cover the transition
        }

        // Occlusion can be greater than one due to unnormalised energy at this point
        // so we only interpolate when occlusion is less than one, otherwise we assume
        // near range fully obscures far range
        if (occlusion < 1)
            c = c * (1 - min(1, near.w)) + near;
        else
            c = near;

        // normalize so the image doesn't get brighter or dimmer
        if (c.w > 0.00001f)
            c.xyz /= c.w;
    }

    return float4(c.xyz, 1);
}

// --- BasicPostProcess::Copy ------------------------------------------------------------------

// The scene's color into the back buffer, texel for texel (the sample's copy samples it at the
// same size).
float4 copy_ps(PSSceneIn input) : SV_Target
{
    return t0.Load(uint3(input.pos.xy, 0));
}

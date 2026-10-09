//--------------------------------------------------------------------------------------
// Fast block compression ComputeShaders for BC1, BC3 and BC5
//
// Advanced Technology Group (ATG)
// Copyright (C) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
//--------------------------------------------------------------------------------------

// Port of the Xbox ATG FastBlockCompress sample's compression shaders (BC1Compress.hlsl,
// BC1Compress2Mips.hlsl, BC1CompressTailMips.hlsl and their BC3 and BC5 versions) to Donut's
// bindings, one file built per format: FORMAT 1, 3 or 5. The blocks go into R32G32_UINT (BC1) or
// R32G32B32A32_UINT (BC3, BC5) textures, a texel per block, which the TypeScript side copies into
// the BC texture (the sample aliases the BC texture's memory on Xbox One instead).
//
// The tail mips shader's threads for the 8x8 to 1x1 levels also compute blocks outside those
// levels; D3D drops such writes, Vulkan doesn't promise to, so the stores here check the
// texture's size first.

#include "fast_block_compress.hlsli"

#if FORMAT == 1
#define BlockType uint2
#define BLOCK_IMAGE_FORMAT "rg32ui"
#else
#define BlockType uint4
#define BLOCK_IMAGE_FORMAT "rgba32ui"
#endif

Texture2D g_texIn : register(t0);

// Output BC texture as R32G32_UINT / R32G32B32A32_UINT; mips 1 and up for the 2-mips and tail shaders.
VK_IMAGE_FORMAT(BLOCK_IMAGE_FORMAT) RWTexture2D<BlockType> g_texOut0 : register(u0);
VK_IMAGE_FORMAT(BLOCK_IMAGE_FORMAT) RWTexture2D<BlockType> g_texOut1 : register(u1);
VK_IMAGE_FORMAT(BLOCK_IMAGE_FORMAT) RWTexture2D<BlockType> g_texOut2 : register(u2);
VK_IMAGE_FORMAT(BLOCK_IMAGE_FORMAT) RWTexture2D<BlockType> g_texOut3 : register(u3);
VK_IMAGE_FORMAT(BLOCK_IMAGE_FORMAT) RWTexture2D<BlockType> g_texOut4 : register(u4);

SamplerState g_samp : register(s0);

void StoreBlock(RWTexture2D<BlockType> tex, uint2 blockID, BlockType value)
{
    uint width, height;
    tex.GetDimensions(width, height);
    if (blockID.x < width && blockID.y < height)
    {
        tex[blockID] = value;
    }
}

//--------------------------------------------------------------------------------------
// Compress one mip level
//--------------------------------------------------------------------------------------
[numthreads(COMPRESS_ONE_MIP_THREADGROUP_WIDTH, COMPRESS_ONE_MIP_THREADGROUP_WIDTH, 1)]
void compress_cs(
    uint2 threadIDWithinDispatch : SV_DispatchThreadID)
{
#if FORMAT == 1
    float3 block[16];
    LoadTexelsRGB(g_texIn, g_samp, g_oneOverTextureWidth, threadIDWithinDispatch, block);

    g_texOut0[threadIDWithinDispatch] = CompressBC1Block(block);
#elif FORMAT == 3
    float3 blockRGB[16];
    float blockA[16];
    LoadTexelsRGBA(g_texIn, threadIDWithinDispatch, blockRGB, blockA);

    g_texOut0[threadIDWithinDispatch.xy] = CompressBC3Block(blockRGB, blockA, 1.0f);
#else
    float blockU[16], blockV[16];
    LoadTexelsUV(g_texIn, g_samp, g_oneOverTextureWidth, threadIDWithinDispatch, blockU, blockV);

    g_texOut0[threadIDWithinDispatch] = CompressBC5Block(blockU, blockV);
#endif
}

#if FORMAT == 1
groupshared float3 gs_mip1Blocks[MIP1_BLOCKS_PER_ROW * MIP1_BLOCKS_PER_ROW][16];
#elif FORMAT == 3
groupshared float3 gs_mip1BlocksRGB[ MIP1_BLOCKS_PER_ROW * MIP1_BLOCKS_PER_ROW ][16];
groupshared float gs_mip1BlocksA[ MIP1_BLOCKS_PER_ROW * MIP1_BLOCKS_PER_ROW ][16];
#else
groupshared float gs_mip1BlocksU[ MIP1_BLOCKS_PER_ROW * MIP1_BLOCKS_PER_ROW ][16];
groupshared float gs_mip1BlocksV[ MIP1_BLOCKS_PER_ROW * MIP1_BLOCKS_PER_ROW ][16];
#endif

//--------------------------------------------------------------------------------------
// Calculate the texels for mip level n+1
//--------------------------------------------------------------------------------------
#if FORMAT == 1
void DownsampleMip(uint2 threadIDWithinGroup, float3 block[16])
{
    // Find the block and texel index for this thread within the group
    uint2 blockID = threadIDWithinGroup / 2;
    uint2 texelID = 2 * (threadIDWithinGroup - 2 * blockID);
    uint blockIndex = blockID.y * MIP1_BLOCKS_PER_ROW + blockID.x;
    uint texelIndex = texelID.y * 4 + texelID.x;  // A block is 4x4 texels

    // We average the colors later by passing a scale value into CompressBC1Block. This allows
    //  us to avoid scaling all 16 colors in the block: we really only need to scale the min
    //  and max values.
    gs_mip1Blocks[blockIndex][texelIndex] = block[0] + block[1] + block[4] + block[5];
    gs_mip1Blocks[blockIndex][texelIndex + 1] = block[2] + block[3] + block[6] + block[7];
    gs_mip1Blocks[blockIndex][texelIndex + 4] = block[8] + block[9] + block[12] + block[13];
    gs_mip1Blocks[blockIndex][texelIndex + 5] = block[10] + block[11] + block[14] + block[15];
}
#elif FORMAT == 3
void DownsampleMip(uint2 threadIDWithinGroup, float3 blockRGB[16], float blockA[16])
{
    // Find the block and texel index for this thread within the group
    uint2 blockID = threadIDWithinGroup.xy / 2;
    uint2 texelID = 2 * (threadIDWithinGroup.xy - 2 * blockID);
    uint blockIndex = blockID.y * MIP1_BLOCKS_PER_ROW + blockID.x;
    uint texelIndex = texelID.y * 4 + texelID.x;  // A block is 4x4 texels

    // We average the colors later by passing a scale value into CompressBC3Block. This allows
    //  us to avoid scaling all 16 colors in the block: we really only need to scale the min
    //  and max values.
    gs_mip1BlocksRGB[blockIndex][texelIndex] = blockRGB[0] + blockRGB[1] + blockRGB[4] + blockRGB[5];
    gs_mip1BlocksRGB[blockIndex][texelIndex + 1] = blockRGB[2] + blockRGB[3] + blockRGB[6] + blockRGB[7];
    gs_mip1BlocksRGB[blockIndex][texelIndex + 4] = blockRGB[8] + blockRGB[9] + blockRGB[12] + blockRGB[13];
    gs_mip1BlocksRGB[blockIndex][texelIndex + 5] = blockRGB[10] + blockRGB[11] + blockRGB[14] + blockRGB[15];
    gs_mip1BlocksA[blockIndex][texelIndex] = blockA[0] + blockA[1] + blockA[4] + blockA[5];
    gs_mip1BlocksA[blockIndex][texelIndex + 1] = blockA[2] + blockA[3] + blockA[6] + blockA[7];
    gs_mip1BlocksA[blockIndex][texelIndex + 4] = blockA[8] + blockA[9] + blockA[12] + blockA[13];
    gs_mip1BlocksA[blockIndex][texelIndex + 5] = blockA[10] + blockA[11] + blockA[14] + blockA[15];
}
#else
void DownsampleMip(uint2 threadIDWithinGroup, float blockU[16], float blockV[16])
{
    // Find the block and texel index for this thread within the group
    uint2 blockID = threadIDWithinGroup / 2;
    uint2 texelID = 2 * (threadIDWithinGroup - 2 * blockID);
    uint blockIndex = blockID.y * MIP1_BLOCKS_PER_ROW + blockID.x;
    uint texelIndex = texelID.y * 4 + texelID.x;  // A block is 4x4 texels

    // We average the colors later by passing a scale value into CompressBC1Block. This allows
    //  us to avoid scaling all 16 colors in the block: we really only need to scale the min
    //  and max values.
    gs_mip1BlocksU[blockIndex][texelIndex] = blockU[0] + blockU[1] + blockU[4] + blockU[5];
    gs_mip1BlocksU[blockIndex][texelIndex + 1] = blockU[2] + blockU[3] + blockU[6] + blockU[7];
    gs_mip1BlocksU[blockIndex][texelIndex + 4] = blockU[8] + blockU[9] + blockU[12] + blockU[13];
    gs_mip1BlocksU[blockIndex][texelIndex + 5] = blockU[10] + blockU[11] + blockU[14] + blockU[15];
    gs_mip1BlocksV[blockIndex][texelIndex] = blockV[0] + blockV[1] + blockV[4] + blockV[5];
    gs_mip1BlocksV[blockIndex][texelIndex + 1] = blockV[2] + blockV[3] + blockV[6] + blockV[7];
    gs_mip1BlocksV[blockIndex][texelIndex + 4] = blockV[8] + blockV[9] + blockV[12] + blockV[13];
    gs_mip1BlocksV[blockIndex][texelIndex + 5] = blockV[10] + blockV[11] + blockV[14] + blockV[15];
}
#endif

//--------------------------------------------------------------------------------------
// Compress two mip levels at once by downsampling into LDS
//--------------------------------------------------------------------------------------
[numthreads(COMPRESS_TWO_MIPS_THREADGROUP_WIDTH, COMPRESS_TWO_MIPS_THREADGROUP_WIDTH, 1)]
void compress_2mips_cs(
    uint2 threadIDWithinDispatch : SV_DispatchThreadID,
    uint2 threadIDWithinGroup : SV_GroupThreadID,
    uint threadIndexWithinGroup : SV_GroupIndex,
    uint2 groupIDWithinDispatch : SV_GroupID)
{
#if FORMAT == 1
    // Load the texels in our mip 0 block
    float3 block[16];
    LoadTexelsRGB(g_texIn, g_samp, g_oneOverTextureWidth, threadIDWithinDispatch, block);

    // Downsample from mip 0 to mip 1
    DownsampleMip(threadIDWithinGroup, block);
    GroupMemoryBarrierWithGroupSync();

    g_texOut0[threadIDWithinDispatch] = CompressBC1Block(block, 1.0f);
#elif FORMAT == 3
    // Load the texels in our block
    float3 blockRGB[16];
    float blockA[16];
    LoadTexelsRGBA(g_texIn, threadIDWithinDispatch, blockRGB, blockA);

    // Downsample from mip 0 to mip 1
    DownsampleMip(threadIDWithinGroup, blockRGB, blockA);
    GroupMemoryBarrierWithGroupSync();

    g_texOut0[threadIDWithinDispatch.xy] = CompressBC3Block(blockRGB, blockA);
#else
    // Load the texels in our block
    float blockU[16], blockV[16];
    LoadTexelsUV(g_texIn, g_samp, g_oneOverTextureWidth, threadIDWithinDispatch, blockU, blockV);

    // Downsample from mip 0 to mip 1
    DownsampleMip(threadIDWithinGroup, blockU, blockV);
    GroupMemoryBarrierWithGroupSync();

    g_texOut0[threadIDWithinDispatch] = CompressBC5Block(blockU, blockV, 1.0f);
#endif

    // When compressing two mips at a time, we use a group size of 16x16. This produces four 64-thread wavefronts.
    // The first wavefronts will execute the code below and the other three will retire.
    if (threadIndexWithinGroup < MIP1_BLOCKS_PER_ROW * MIP1_BLOCKS_PER_ROW)
    {
        uint2 texelID = uint2(threadIndexWithinGroup % MIP1_BLOCKS_PER_ROW, threadIndexWithinGroup / MIP1_BLOCKS_PER_ROW);

        // Pass a scale value of 0.25 to the Compress*Block function to average the four source values contributing
        //  to each pixel in the block. See the comment in DownsampleMip, above.
#if FORMAT == 1
        g_texOut1[groupIDWithinDispatch * MIP1_BLOCKS_PER_ROW + texelID] = CompressBC1Block(gs_mip1Blocks[threadIndexWithinGroup], 0.25f);
#elif FORMAT == 3
        uint4 compressed = CompressBC3Block(gs_mip1BlocksRGB[threadIndexWithinGroup], gs_mip1BlocksA[threadIndexWithinGroup], 0.25f);
        g_texOut1[groupIDWithinDispatch.xy * MIP1_BLOCKS_PER_ROW + texelID] = compressed;
#else
        uint4 compressed = CompressBC5Block(gs_mip1BlocksU[threadIndexWithinGroup], gs_mip1BlocksV[threadIndexWithinGroup], 0.25f);
        g_texOut1[groupIDWithinDispatch * MIP1_BLOCKS_PER_ROW + texelID] = compressed;
#endif
    }
}

//--------------------------------------------------------------------------------------
// Compress the "tail" mips 16x16, 8x8, 4x4, 2x2, and 1x1
//--------------------------------------------------------------------------------------
[numthreads(COMPRESS_ONE_MIP_THREADGROUP_WIDTH, COMPRESS_ONE_MIP_THREADGROUP_WIDTH, 1)]
void compress_tail_cs(
    uint2 threadIDWithinDispatch : SV_DispatchThreadID)
{
    int mipBias = 0;
    float oneOverTextureSize = 1.0f;
    uint2 blockID = threadIDWithinDispatch;

    // Different threads in the threadgroup work on different mip levels
    CalcTailMipsParams(threadIDWithinDispatch, oneOverTextureSize, blockID, mipBias);
#if FORMAT == 1
    float3 block[16];
    LoadTexelsRGBBias(g_texIn, g_samp, oneOverTextureSize, blockID, mipBias, block);
    BlockType compressed = CompressBC1Block(block, 1.0f);
#elif FORMAT == 3
    float3 blockRGB[16];
    float blockA[16];
    LoadTexelsRGBABias(g_texIn, g_samp, oneOverTextureSize, blockID, mipBias, blockRGB, blockA);
    BlockType compressed = CompressBC3Block(blockRGB, blockA, 1.0f);
#else
    float blockU[16], blockV[16];
    LoadTexelsUVBias(g_texIn, g_samp, oneOverTextureSize, blockID, mipBias, blockU, blockV);
    BlockType compressed = CompressBC5Block(blockU, blockV, 1.0f);
#endif

    if (mipBias == 0)
    {
        StoreBlock(g_texOut0, blockID, compressed);
    }
    else if (mipBias == 1)
    {
        StoreBlock(g_texOut1, blockID, compressed);
    }
    else if (mipBias == 2)
    {
        StoreBlock(g_texOut2, blockID, compressed);
    }
    else if (mipBias == 3)
    {
        StoreBlock(g_texOut3, blockID, compressed);
    }
    else if (mipBias == 4)
    {
        StoreBlock(g_texOut4, blockID, compressed);
    }
}

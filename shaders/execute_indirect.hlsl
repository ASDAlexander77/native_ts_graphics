// DirectX-Graphics-Samples' D3D12ExecuteIndirect shaders (shaders.hlsl, compute.hlsl): triangles
// drawn by indirect commands, which a compute shader can first cull to those whose bounds lie
// within a band of the screen.
//
// The sample's indirect commands change a root constant buffer view per draw, which NVRHI's
// indirect draws (and Vulkan's) can't: here each command is an indexed draw whose start instance
// is its triangle's index, which an instance-rate vertex attribute hands the vertex shader to read
// the triangle's constants from a structured buffer. NVRHI has no UAV counters either: the compute
// shader appends to a byte address buffer, counting with an atomic add into another.
//
// Copyright (c) Microsoft. All rights reserved.
// This code is licensed under the MIT License (MIT).

#include <donut/shaders/binding_helpers.hlsli>

struct SceneConstantBuffer
{
    float4 velocity;
    float4 offset;
    float4 color;
    float4x4 projection;
    float4 padding[9];
};


/////
// Rendering

StructuredBuffer<SceneConstantBuffer> constants : register(t0);

struct PSInput
{
    float4 position : SV_POSITION;
    float4 color : COLOR;
};

PSInput VSMain(float4 position : POSITION, uint triangleIndex : TRIANGLE)
{
    SceneConstantBuffer cb = constants[triangleIndex];

    PSInput result;

    result.position = mul(position + cb.offset, cb.projection);

    float intensity = saturate((4.0f - result.position.z) / 2.0f);
    result.color = float4(cb.color.xyz * intensity, 1.0f);

    return result;
}

float4 PSMain(PSInput input) : SV_TARGET
{
    return input.color;
}


/////
// Culling

#define threadBlockSize 128

// D3D12_DRAW_INDEXED_ARGUMENTS.
struct IndirectCommand
{
    uint indexCountPerInstance;
    uint instanceCount;
    uint startIndexLocation;
    int  baseVertexLocation;
    uint startInstanceLocation;
};

struct RootConstants
{
    float xOffset;        // Half the width of the triangles.
    float zOffset;        // The z offset for the triangle vertices.
    float cullOffset;     // The culling plane offset in homogenous space.
    float commandCount;   // The number of commands to be processed.
    float frameOffset;    // The frame's first constant buffer and command (the sample's SRVs start there).
};

DECLARE_PUSH_CONSTANTS(RootConstants, g_RootConstants, 0, 0);

StructuredBuffer<SceneConstantBuffer> cbv           : register(t0);    // SRV: Wrapped constant buffers
ByteAddressBuffer inputCommands                     : register(t1);    // SRV: Indirect commands (20 bytes each)
RWByteAddressBuffer outputCommands                  : register(u0);    // UAV: Processed indirect commands
RWByteAddressBuffer outputCount                     : register(u1);    // UAV: Their count

[numthreads(threadBlockSize, 1, 1)]
void CSMain(uint3 groupId : SV_GroupID, uint groupIndex : SV_GroupIndex)
{
    // Each thread of the CS operates on one of the indirect commands.
    uint index = (groupId.x * threadBlockSize) + groupIndex;

    // Don't attempt to access commands that don't exist if more threads are allocated
    // than commands.
    if (index < g_RootConstants.commandCount)
    {
        uint frameOffset = uint(g_RootConstants.frameOffset);
        SceneConstantBuffer cb = cbv[frameOffset + index];

        // Project the left and right bounds of the triangle into homogenous space.
        float4 left = float4(-g_RootConstants.xOffset, 0.0f, g_RootConstants.zOffset, 1.0f) + cb.offset;
        left = mul(left, cb.projection);
        left /= left.w;

        float4 right = float4(g_RootConstants.xOffset, 0.0f, g_RootConstants.zOffset, 1.0f) + cb.offset;
        right = mul(right, cb.projection);
        right /= right.w;

        // Only draw triangles that are within the culling space.
        if (-g_RootConstants.cullOffset < right.x && left.x < g_RootConstants.cullOffset)
        {
            uint commandAddress = (frameOffset + index) * 20;
            uint slot;
            outputCount.InterlockedAdd(0, 1, slot);
            outputCommands.Store4(slot * 20, inputCommands.Load4(commandAddress));
            outputCommands.Store(slot * 20 + 16, inputCommands.Load(commandAddress + 16));
        }
    }
}

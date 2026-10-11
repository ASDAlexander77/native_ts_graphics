// Vulkan-Samples' buffer_device_address shaders (update_vbo.comp, render.vert, render.frag) in HLSL,
// for examples/buffer_device_address.ts: 64 meshes (16 x 16 vertices of float2 each), each in a
// buffer reached through its device address alone. A table of the 64 addresses (a buffer of
// uint64s) is itself reached through its address, in push constants: no descriptors at all. The
// GLSL's buffer_reference pointers are vk::RawBufferLoad / vk::RawBufferStore of device addresses
// here (8-byte aligned, as the GLSL's buffer_reference_align = 8). SPIR-V only: D3D shaders have no
// pointers.
//
// Copyright (c) 2021, Arm Limited and Contributors
// SPDX-License-Identifier: Apache-2.0

#include <donut/shaders/binding_helpers.hlsli>

// The compute shader's push constants: the address of the table of mesh addresses, the animation
// time (a fraction).
struct ComputeRegisters
{
    uint64_t references;
    float fractTime;
};

// The vertex shader's: the view-projection matrix (column-major, as glm's), the table's address.
struct VertexRegisters
{
    float4x4 viewProjection;
    uint64_t references;
};

#ifdef UPDATE_VBO
DECLARE_PUSH_CONSTANTS(ComputeRegisters, g_Registers, 0, 0);
#else
DECLARE_PUSH_CONSTANTS(VertexRegisters, g_Registers, 0, 0);
#endif

static const uint WORKGROUP_SIZE = 8;

// update_vbo.comp: every slice is an 8 x 8 grid of vertices (2 x 2 groups of them), updated here.
[numthreads(WORKGROUP_SIZE, WORKGROUP_SIZE, 1)]
void update_vbo_cs(uint3 globalId : SV_DispatchThreadID, uint3 groupId : SV_GroupID)
{
#ifdef UPDATE_VBO
    // The dispatch's 2 x 2 groups per slice.
    const uint2 numWorkGroups = uint2(2, 2);
    uint2 localOffset = globalId.xy;
    uint localIndex = localOffset.y * WORKGROUP_SIZE * numWorkGroups.x + localOffset.x;
    uint slice = groupId.z;

    // The slice's mesh: its address, loaded from the table.
    uint64_t positions = vk::RawBufferLoad<uint64_t>(g_Registers.references + uint64_t(slice) * 8, 8);

    // This is a trivial wave-like function. Arbitrary for demonstration purposes.
    const float TWO_PI = 3.1415628 * 2.0;
    float offset = TWO_PI * frac(g_Registers.fractTime + float(slice) * 0.1);

    // Simple grid.
    float2 pos = float2(localOffset);

    // Wobble, wobble.
    pos.x += 0.2 * sin(2.2 * pos.x + offset);
    pos.y += 0.2 * sin(2.25 * pos.y + 2.0 * offset);
    pos.x += 0.2 * cos(1.8 * pos.y + 3.0 * offset);
    pos.y += 0.2 * cos(2.85 * pos.x + 4.0 * offset);
    pos.x += 0.5 * sin(offset);
    pos.y += 0.5 * sin(offset + 0.3);

    // Center the mesh in [-0.5, 0.5] range, written through the raw address.
    vk::RawBufferStore<float2>(positions + uint64_t(localIndex) * 8,
        pos / (float2(WORKGROUP_SIZE, WORKGROUP_SIZE) * float2(numWorkGroups) - 1.0) - 0.5, 8);
#endif
}

struct VSOutput
{
    float4 position : SV_Position;
    nointerpolation float4 color : COLOR;
};

// render.vert: one mesh per instance, its address loaded from the table; the vertex loaded from it
// by its index rather than through vertex attributes.
VSOutput render_vs(uint vertexIndex : SV_VertexID, uint instanceIndex : SV_InstanceID)
{
    VSOutput output;
#ifndef UPDATE_VBO
    int slice = int(instanceIndex);
    uint64_t positions = vk::RawBufferLoad<uint64_t>(g_Registers.references + uint64_t(slice) * 8, 8);
    float2 pos = vk::RawBufferLoad<float2>(positions + uint64_t(vertexIndex) * 8, 8) * 2.5;

    // Place the quad meshes on screen and center it.
    pos += 3.0 * (float2(slice % 8, slice / 8) - 3.5);

    // Normal projection.
    output.position = mul(g_Registers.viewProjection, float4(pos, 0.0, 1.0));

    // Color the vertex. Use a combination of a wave and checkerboard, completely arbitrary.
    int indexX = int(vertexIndex) % 16;
    int indexY = int(vertexIndex) / 16;

    float r = 0.5 + 0.3 * sin(float(indexX));
    float g = 0.5 + 0.3 * sin(float(indexY));

    int checkerboard = (indexX ^ indexY) & 1;
    r *= float(checkerboard) * 0.8 + 0.2;
    g *= float(checkerboard) * 0.8 + 0.2;

    output.color = float4(r, g, 0.15, 1.0);
#else
    output.position = 0;
    output.color = 0;
#endif
    return output;
}

// render.frag: the vertex's flat color.
float4 render_ps(VSOutput input) : SV_Target
{
    return input.color;
}

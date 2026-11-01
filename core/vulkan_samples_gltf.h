// A glTF primitive as the Vulkan-Samples framework reads one (its load_model), shared by Donut's
// interop (Donut_LoadGltfMesh, Donut_LoadGltfModel) and NRI's (Nri_LoadGltfMesh), so both draw the
// same vertices. Include after cgltf.h.
#pragma once

#include <cstdint>
#include <vector>

// A glTF primitive as the Vulkan-Samples framework reads one: positions, normals and texture
// coordinates interleaved (8 floats per vertex, zeros for missing attributes), 32-bit
// indices. Returns false if it has no positions, or no indices and requireIndices.
inline bool ReadGltfPrimitive(const cgltf_primitive& primitive, std::vector<float>& vertices, std::vector<uint32_t>& indices,
    bool requireIndices = true)
{
    const cgltf_accessor* positions = nullptr;
    const cgltf_accessor* normals = nullptr;
    const cgltf_accessor* texCoords = nullptr;
    for (size_t i = 0; i < primitive.attributes_count; i++)
    {
        const cgltf_attribute& attribute = primitive.attributes[i];
        if (attribute.type == cgltf_attribute_type_position)
            positions = attribute.data;
        else if (attribute.type == cgltf_attribute_type_normal)
            normals = attribute.data;
        else if (attribute.type == cgltf_attribute_type_texcoord && attribute.index == 0)
            texCoords = attribute.data;
    }
    if (!positions || (!primitive.indices && requireIndices))
        return false;

    constexpr size_t vertexFloats = 8;
    vertices.assign(positions->count * vertexFloats, 0.f);
    for (size_t v = 0; v < positions->count; v++)
    {
        float* vertex = &vertices[v * vertexFloats];
        cgltf_accessor_read_float(positions, v, vertex, 3);
        if (normals)
            cgltf_accessor_read_float(normals, v, vertex + 3, 3);
        if (texCoords)
            cgltf_accessor_read_float(texCoords, v, vertex + 6, 2);
    }
    indices.resize(primitive.indices ? primitive.indices->count : 0);
    for (size_t i = 0; i < indices.size(); i++)
        indices[i] = static_cast<uint32_t>(cgltf_accessor_read_index(primitive.indices, i));
    return true;
}

// A glTF primitive as the Vulkan-Samples framework reads one (its load_model), and every primitive
// of a file with its materials and nodes, shared by Donut's interop (Donut_LoadGltfMesh,
// Donut_LoadGltfModel) and NRI's (Nri_LoadGltfMesh, Nri_LoadGltfModel), so both draw the same
// vertices. Include after cgltf.h.
#pragma once

#include <cstdint>
#include <cstring>
#include <map>
#include <string>
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

// Every mesh primitive of a glTF file, kept on the CPU (Donut_LoadGltfModel, Nri_LoadGltfModel).
struct GltfModel
{
    struct Primitive
    {
        // float3 position, float3 normal, float2 texture coordinates.
        std::vector<float> vertices;
        std::vector<uint32_t> indices;
        // The URI of the material's base color image ("" if none).
        std::string baseColorImage;
        // The name of the primitive's mesh ("" if none).
        std::string meshName;
        // The index of the primitive's mesh.
        int mesh = 0;
        // Its material's alpha mode: 0 opaque, 1 mask, 2 blend.
        int alphaMode = 0;
        // Its material's base color factor.
        float baseColorFactor[4] = { 1.f, 1.f, 1.f, 1.f };
        // Its material's metallic and roughness factors, and its textures (indices into the
        // file's textures; -1 if none): base color, normal, metallic-roughness.
        float metallicFactor = 1.f;
        float roughnessFactor = 1.f;
        int materialTextures[3] = { -1, -1, -1 };
        // Every vertex attribute, by its name in the file (POSITION, COLOR_0, an extension's
        // "KHR_gaussian_splatting:SCALE"...), as floats (normalized integers converted).
        struct Attribute
        {
            int components = 0;
            std::vector<float> data;
        };
        std::map<std::string, Attribute> attributes;
    };
    std::vector<Primitive> primitives;
    // The file's textures' image URIs ("" if none), in texture order.
    std::vector<std::string> textureImages;

    // The nodes that instantiate meshes, in node order.
    struct Node
    {
        int mesh = 0;
        // World transform, column-major (glm's layout).
        float transform[16] = {};
    };
    std::vector<Node> nodes;
};

// Every primitive of a glTF file's meshes (cgltf_load_buffers done), in mesh and primitive order, as
// the Vulkan-Samples framework's scene loader reads them into submeshes: vertices as
// ReadGltfPrimitive's (in mesh space, the nodes' transforms ignored), indices, every attribute, the
// material's factors, textures and alpha mode; the file's textures and the nodes that instantiate
// meshes. Returns false (error saying why) on failure.
inline bool ReadGltfModel(const cgltf_data* data, GltfModel& model, std::string& error)
{
    for (size_t m = 0; m < data->meshes_count; m++)
    {
        const cgltf_mesh& mesh = data->meshes[m];
        for (size_t p = 0; p < mesh.primitives_count; p++)
        {
            GltfModel::Primitive primitive;
            if (!ReadGltfPrimitive(mesh.primitives[p], primitive.vertices, primitive.indices, false))
            {
                error = "Mesh " + std::to_string(m) + " has a primitive without positions";
                return false;
            }
            for (size_t a = 0; a < mesh.primitives[p].attributes_count; a++)
            {
                const cgltf_attribute& attribute = mesh.primitives[p].attributes[a];
                if (!attribute.name || !attribute.data)
                    continue;
                GltfModel::Primitive::Attribute& dst = primitive.attributes[attribute.name];
                dst.components = static_cast<int>(cgltf_num_components(attribute.data->type));
                dst.data.resize(attribute.data->count * size_t(dst.components));
                cgltf_accessor_unpack_floats(attribute.data, dst.data.data(), dst.data.size());
            }
            const cgltf_material* material = mesh.primitives[p].material;
            const cgltf_texture* texture = material ? material->pbr_metallic_roughness.base_color_texture.texture : nullptr;
            if (texture && texture->image && texture->image->uri)
                primitive.baseColorImage = texture->image->uri;
            if (mesh.name)
                primitive.meshName = mesh.name;
            if (material && material->has_pbr_metallic_roughness)
            {
                memcpy(primitive.baseColorFactor, material->pbr_metallic_roughness.base_color_factor, sizeof(primitive.baseColorFactor));
                primitive.metallicFactor = material->pbr_metallic_roughness.metallic_factor;
                primitive.roughnessFactor = material->pbr_metallic_roughness.roughness_factor;
            }
            if (material)
            {
                const cgltf_texture* textures[3] = { material->pbr_metallic_roughness.base_color_texture.texture,
                    material->normal_texture.texture, material->pbr_metallic_roughness.metallic_roughness_texture.texture };
                for (int t = 0; t < 3; t++)
                    primitive.materialTextures[t] = textures[t] ? static_cast<int>(cgltf_texture_index(data, textures[t])) : -1;
            }
            primitive.mesh = static_cast<int>(m);
            if (material && material->alpha_mode == cgltf_alpha_mode_mask)
                primitive.alphaMode = 1;
            else if (material && material->alpha_mode == cgltf_alpha_mode_blend)
                primitive.alphaMode = 2;
            model.primitives.push_back(std::move(primitive));
        }
    }
    for (size_t t = 0; t < data->textures_count; t++)
    {
        const cgltf_texture& texture = data->textures[t];
        model.textureImages.push_back(texture.image && texture.image->uri ? texture.image->uri : "");
    }
    for (size_t n = 0; n < data->nodes_count; n++)
    {
        const cgltf_node& node = data->nodes[n];
        if (!node.mesh)
            continue;
        GltfModel::Node modelNode;
        modelNode.mesh = static_cast<int>(node.mesh - data->meshes);
        cgltf_node_transform_world(&node, modelNode.transform);
        model.nodes.push_back(modelNode);
    }
    return true;
}

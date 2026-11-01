// A glTF scene as Donut's engine loads it (GltfImporter, SceneGraph, Scene), for the NRI ports of the
// Donut examples that draw Donut scenes (examples/nri/bindless_rendering_nri.ts): the scene buffers
// Donut's scene shaders read (donut/shaders/bindless.h's InstanceData and GeometryData,
// material_cb.h's MaterialConstants), the vertices as Donut's BufferGroup holds them (all the
// positions, then all the texture coordinates) and the indices, with Donut's own math for the node
// transforms, so the ports draw the same pixels. What the shaders don't read isn't imported (normals,
// tangents, materials' other textures); the base color textures are numbered in the order their
// materials first use them (Donut numbers them as its loader threads finish: the shaders only
// follow the numbers). A translation unit of its own, as nri_donut_constants.cpp.

#include <donut/core/math/math.h>

#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "cgltf.h"

using namespace donut::math;

#include <donut/shaders/bindless.h>
#include <donut/shaders/material_cb.h>

#ifdef _WIN32
#define NRI_INTEROP_API __declspec(dllexport)
#else
#define NRI_INTEROP_API __attribute__((visibility("default")))
#endif

// nri_interop.cpp's.
std::string NriLibraryPath(const char* path);
extern "C" NRI_INTEROP_API void* Nri_CreateUploadedStructuredBuffer(void* device, void* queue, const void* data, int byteSize, int stride);

namespace
{
    struct DonutScene
    {
        // The mesh buffers: Donut's BufferGroup of the file (vertex buffer: the positions, then the
        // texture coordinates), its bindless buffer numbers 0 (vertices) and 1 (indices).
        std::vector<float> vertices;
        std::vector<uint32_t> indices;
        std::vector<InstanceData> instances;
        std::vector<GeometryData> geometries;
        std::vector<MaterialConstants> materials;
        // The base color textures' files (relative to the library's folder), in texture number order.
        std::vector<std::string> textures;
    };

    // MaterialConstants as Material::FillConstantBuffer fills them from a material GltfImporter
    // imports (the base color texture, numbered texture, if any), or Donut's default material (null).
    MaterialConstants ImportMaterial(const cgltf_material* material, int texture)
    {
        // Material's defaults.
        float3 baseOrDiffuseColor = 1.f;
        float3 specularColor = 0.f;
        float3 emissiveColor = 0.f;
        float emissiveIntensity = 1.f;
        float metalness = 0.f;
        float roughness = 0.f;
        float opacity = 1.f;
        float alphaCutoff = 0.5f;
        float normalTextureScale = 1.f;
        float occlusionStrength = 1.f;
        bool useSpecularGlossModel = false;
        bool doubleSided = false;
        int domain = MaterialDomain_Opaque;

        if (material)
        {
            if (material->has_pbr_specular_glossiness)
            {
                useSpecularGlossModel = true;
                baseOrDiffuseColor = float3(material->pbr_specular_glossiness.diffuse_factor);
                specularColor = float3(material->pbr_specular_glossiness.specular_factor);
                roughness = 1.f - material->pbr_specular_glossiness.glossiness_factor;
                opacity = material->pbr_specular_glossiness.diffuse_factor[3];
            }
            else if (material->has_pbr_metallic_roughness)
            {
                baseOrDiffuseColor = float3(material->pbr_metallic_roughness.base_color_factor);
                metalness = material->pbr_metallic_roughness.metallic_factor;
                roughness = material->pbr_metallic_roughness.roughness_factor;
                opacity = material->pbr_metallic_roughness.base_color_factor[3];
            }
            emissiveColor = float3(material->emissive_factor);
            if (material->has_emissive_strength)
                emissiveIntensity = material->emissive_strength.emissive_strength;
            else
            {
                emissiveIntensity = maxComponent(emissiveColor);
                if (emissiveIntensity > 0.f)
                    emissiveColor /= emissiveIntensity;
                else
                    emissiveIntensity = 1.f;
            }
            normalTextureScale = material->normal_texture.scale;
            occlusionStrength = material->occlusion_texture.scale;
            alphaCutoff = material->alpha_cutoff;
            doubleSided = material->double_sided;
            const bool transmission = material->has_transmission;
            switch (material->alpha_mode)
            {
            case cgltf_alpha_mode_opaque: domain = transmission ? MaterialDomain_Transmissive : MaterialDomain_Opaque; break;
            case cgltf_alpha_mode_mask: domain = transmission ? MaterialDomain_TransmissiveAlphaTested : MaterialDomain_AlphaTested; break;
            case cgltf_alpha_mode_blend: domain = transmission ? MaterialDomain_TransmissiveAlphaBlended : MaterialDomain_AlphaBlended; break;
            default: break;
            }
        }

        MaterialConstants constants = {};
        constants.flags = 0;
        if (useSpecularGlossModel)
            constants.flags |= MaterialFlags_UseSpecularGlossModel;
        if (texture >= 0)
            constants.flags |= MaterialFlags_UseBaseOrDiffuseTexture;
        if (doubleSided)
            constants.flags |= MaterialFlags_DoubleSided;
        constants.domain = domain;
        constants.baseOrDiffuseColor = baseOrDiffuseColor;
        constants.specularColor = specularColor;
        constants.emissiveColor = emissiveColor * emissiveIntensity;
        constants.roughness = roughness;
        constants.metalness = metalness;
        constants.normalTextureScale = normalTextureScale;
        constants.occlusionStrength = occlusionStrength;
        constants.normalTextureTransformScale = float2(1.f);
        const bool blended = domain == MaterialDomain_AlphaBlended || domain == MaterialDomain_TransmissiveAlphaBlended;
        const bool tested = domain == MaterialDomain_AlphaTested || domain == MaterialDomain_TransmissiveAlphaTested;
        constants.opacity = blended ? opacity : 1.f;
        constants.alphaCutoff = tested ? alphaCutoff : blended ? 0.f : -1.f;
        constants.baseOrDiffuseTextureIndex = texture;
        constants.metalRoughOrSpecularTextureIndex = -1;
        constants.normalTextureIndex = -1;
        constants.emissiveTextureIndex = -1;
        constants.occlusionTextureIndex = -1;
        constants.transmissionTextureIndex = -1;
        constants.opacityTextureIndex = -1;
        return constants;
    }

    // A node's transform relative to its parent: SceneGraphNode's TRS, as GltfImporter sets them
    // (a matrix decomposed), composed as UpdateLocalTransform does.
    daffine3 LocalTransform(const cgltf_node& node)
    {
        double3 translationValue = 0.0;
        dquat rotation = dquat::identity();
        double3 scale = 1.0;
        if (node.has_matrix)
        {
            const affine3 matrix = affine3(&node.matrix[0], &node.matrix[4], &node.matrix[8], &node.matrix[12]);
            decomposeAffine(daffine3(matrix), &translationValue, &rotation, &scale);
        }
        else
        {
            if (node.has_scale)
                scale = double3(float3(node.scale));
            if (node.has_rotation)
                rotation = dquat(quat::fromXYZW(node.rotation));
            if (node.has_translation)
                translationValue = double3(float3(node.translation));
        }
        daffine3 transform = scaling(scale);
        transform *= rotation.toAffine();
        transform *= translation(translationValue);
        return transform;
    }

    // The scene's node tree, depth first: a mesh instance per node with a mesh (its transform the
    // node's global one, as SceneGraph::Refresh composes it, in floats for the instance data).
    void AddInstances(const cgltf_data* data, const cgltf_node& node, const daffine3& parentToWorld,
        const std::vector<uint32_t>& firstGeometry, DonutScene& scene)
    {
        const daffine3 localToWorld = LocalTransform(node) * parentToWorld;
        if (node.mesh)
        {
            const size_t mesh = size_t(node.mesh - data->meshes);
            InstanceData instance = {};
            affineToColumnMajor(affine3(localToWorld), instance.transform);
            affineToColumnMajor(affine3(localToWorld), instance.prevTransform);
            instance.numGeometries = uint32_t(node.mesh->primitives_count);
            instance.firstGeometryIndex = instance.numGeometries > 0 ? firstGeometry[mesh] : ~0u;
            uint32_t firstGeometryInstance = 0;
            for (const InstanceData& other : scene.instances)
                firstGeometryInstance += other.numGeometries;
            instance.firstGeometryInstanceIndex = firstGeometryInstance;
            scene.instances.push_back(instance);
        }
        for (size_t i = 0; i < node.children_count; i++)
            AddInstances(data, *node.children[i], localToWorld, firstGeometry, scene);
    }

    // Reads the file (path relative to the library's folder); false (after printing why) on failure.
    bool LoadScene(const char* path, DonutScene& scene)
    {
        const std::string fileName = NriLibraryPath(path);
        cgltf_options options{};
        cgltf_data* data = nullptr;
        cgltf_result result = cgltf_parse_file(&options, fileName.c_str(), &data);
        if (result == cgltf_result_success)
            result = cgltf_load_buffers(&options, data, fileName.c_str());
        if (result != cgltf_result_success)
        {
            printf("ERROR: cannot parse %s\n", fileName.c_str());
            if (data)
                cgltf_free(data);
            return false;
        }
        std::unique_ptr<cgltf_data, void (*)(cgltf_data*)> owner(data, cgltf_free);

        // The textures' files, relative to the library's folder as the scene's path is.
        const std::string relative = path;
        const size_t slash = relative.find_last_of("/\\");
        const std::string folder = slash == std::string::npos ? std::string() : relative.substr(0, slash + 1);
        std::map<const cgltf_image*, int> textureNumbers;
        auto baseColorTexture = [&](const cgltf_material* material) -> int {
            if (!material)
                return -1;
            const cgltf_texture* texture = material->has_pbr_specular_glossiness
                ? material->pbr_specular_glossiness.diffuse_texture.texture
                : material->has_pbr_metallic_roughness ? material->pbr_metallic_roughness.base_color_texture.texture : nullptr;
            if (!texture || !texture->image || !texture->image->uri)
                return -1;
            auto found = textureNumbers.find(texture->image);
            if (found != textureNumbers.end())
                return found->second;
            std::string uri = texture->image->uri;
            cgltf_decode_uri(uri.data());
            uri.resize(strlen(uri.c_str()));
            const int number = int(scene.textures.size());
            scene.textures.push_back(folder + uri);
            textureNumbers[texture->image] = number;
            return number;
        };

        // The materials, then Donut's default material for primitives without one.
        std::map<const cgltf_material*, uint32_t> materialIDs;
        for (size_t i = 0; i < data->materials_count; i++)
        {
            materialIDs[&data->materials[i]] = uint32_t(scene.materials.size());
            scene.materials.push_back(ImportMaterial(&data->materials[i], baseColorTexture(&data->materials[i])));
        }
        uint32_t defaultMaterial = ~0u;

        // The meshes' geometries (triangle lists), their vertices and indices one after another.
        std::vector<std::vector<float>> texCoords;
        std::vector<uint32_t> firstGeometry;
        size_t vertexCount = 0;
        for (size_t m = 0; m < data->meshes_count; m++)
        {
            firstGeometry.push_back(uint32_t(scene.geometries.size()));
            const cgltf_mesh& mesh = data->meshes[m];
            for (size_t p = 0; p < mesh.primitives_count; p++)
            {
                const cgltf_primitive& primitive = mesh.primitives[p];
                if (primitive.type != cgltf_primitive_type_triangles)
                {
                    printf("ERROR: %s: only triangle lists are supported\n", path);
                    return false;
                }
                const cgltf_accessor* positions = nullptr;
                const cgltf_accessor* uvs = nullptr;
                for (size_t a = 0; a < primitive.attributes_count; a++)
                {
                    const cgltf_attribute& attribute = primitive.attributes[a];
                    if (attribute.type == cgltf_attribute_type_position)
                        positions = attribute.data;
                    else if (attribute.type == cgltf_attribute_type_texcoord && attribute.index == 0)
                        uvs = attribute.data;
                }
                if (!positions)
                {
                    printf("ERROR: %s: a primitive has no positions\n", path);
                    return false;
                }

                GeometryData geometry = {};
                geometry.numVertices = uint32_t(positions->count);
                geometry.indexBufferIndex = 1;
                geometry.indexOffset = uint32_t(scene.indices.size() * sizeof(uint32_t));
                geometry.vertexBufferIndex = 0;
                // (The texture coordinates' offsets once all the positions are in.)
                geometry.positionOffset = uint32_t(vertexCount * sizeof(float3));
                geometry.prevPositionOffset = ~0u;
                geometry.texCoord1Offset = uint32_t(vertexCount * sizeof(float2));
                geometry.texCoord2Offset = ~0u;
                geometry.normalOffset = ~0u;
                geometry.tangentOffset = ~0u;
                geometry.curveRadiusOffset = ~0u;
                if (primitive.material)
                    geometry.materialIndex = materialIDs[primitive.material];
                else
                {
                    if (defaultMaterial == ~0u)
                    {
                        defaultMaterial = uint32_t(scene.materials.size());
                        scene.materials.push_back(ImportMaterial(nullptr, -1));
                    }
                    geometry.materialIndex = defaultMaterial;
                }

                // Indices as GltfImporter copies them (or 0, 1, 2... without), relative to the
                // geometry's first vertex.
                if (primitive.indices)
                {
                    geometry.numIndices = uint32_t(primitive.indices->count);
                    for (size_t i = 0; i < primitive.indices->count; i++)
                        scene.indices.push_back(uint32_t(cgltf_accessor_read_index(primitive.indices, i)));
                }
                else
                {
                    geometry.numIndices = uint32_t(positions->count);
                    for (size_t i = 0; i < positions->count; i++)
                        scene.indices.push_back(uint32_t(i));
                }

                for (size_t v = 0; v < positions->count; v++)
                {
                    float position[3] = {};
                    cgltf_accessor_read_float(positions, v, position, 3);
                    scene.vertices.insert(scene.vertices.end(), position, position + 3);
                }
                std::vector<float> uv(positions->count * 2, 0.f);
                if (uvs)
                    for (size_t v = 0; v < positions->count && v < uvs->count; v++)
                        cgltf_accessor_read_float(uvs, v, &uv[v * 2], 2);
                texCoords.push_back(std::move(uv));
                vertexCount += positions->count;
                scene.geometries.push_back(geometry);
            }
        }

        // The texture coordinates after the positions.
        const uint32_t texCoordStart = uint32_t(scene.vertices.size() * sizeof(float));
        for (GeometryData& geometry : scene.geometries)
            geometry.texCoord1Offset += texCoordStart;
        for (const std::vector<float>& uv : texCoords)
            scene.vertices.insert(scene.vertices.end(), uv.begin(), uv.end());

        // The instances: the scene's root nodes under the file's root (untransformed).
        const cgltf_scene* root = data->scene ? data->scene : data->scenes_count > 0 ? &data->scenes[0] : nullptr;
        if (root)
            for (size_t i = 0; i < root->nodes_count; i++)
                AddInstances(data, *root->nodes[i], daffine3::identity(), firstGeometry, scene);
        return true;
    }
}

extern "C"
{
    // A glTF scene (path relative to the library's folder) as Donut's engine loads it; null (after
    // printing why) on failure. Destroyed with Nri_DestroyDonutScene.
    NRI_INTEROP_API DonutScene* Nri_LoadDonutScene(const char* path)
    {
        auto scene = std::make_unique<DonutScene>();
        if (!LoadScene(path, *scene))
            return nullptr;
        return scene.release();
    }

    NRI_INTEROP_API void Nri_DestroyDonutScene(DonutScene* scene)
    {
        delete scene;
    }

    // One of the scene's buffers, which: 0 the vertices, 1 the indices (both read as
    // ByteAddressBuffer: structures of 4 bytes), 2 the InstanceData, 3 the GeometryData, 4 the
    // MaterialConstants (StructuredBuffer), in device memory, uploaded on the queue
    // (Nri_CreateUploadedStructuredBuffer's); null on failure.
    NRI_INTEROP_API void* Nri_CreateDonutSceneBuffer(void* device, void* queue, DonutScene* scene, int which)
    {
        switch (which)
        {
        case 0: return Nri_CreateUploadedStructuredBuffer(device, queue, scene->vertices.data(), int(scene->vertices.size() * 4), 4);
        case 1: return Nri_CreateUploadedStructuredBuffer(device, queue, scene->indices.data(), int(scene->indices.size() * 4), 4);
        case 2: return Nri_CreateUploadedStructuredBuffer(device, queue, scene->instances.data(),
            int(scene->instances.size() * sizeof(InstanceData)), int(sizeof(InstanceData)));
        case 3: return Nri_CreateUploadedStructuredBuffer(device, queue, scene->geometries.data(),
            int(scene->geometries.size() * sizeof(GeometryData)), int(sizeof(GeometryData)));
        case 4: return Nri_CreateUploadedStructuredBuffer(device, queue, scene->materials.data(),
            int(scene->materials.size() * sizeof(MaterialConstants)), int(sizeof(MaterialConstants)));
        default: return nullptr;
        }
    }

    // The base color textures (their files relative to the library's folder, sRGB), by number.
    NRI_INTEROP_API int Nri_GetDonutSceneTextureCount(DonutScene* scene)
    {
        return int(scene->textures.size());
    }

    NRI_INTEROP_API const char* Nri_GetDonutSceneTexturePath(DonutScene* scene, int texture)
    {
        return scene->textures[size_t(texture)].c_str();
    }

    // The mesh instances (in the order Donut's scene graph numbers them, each's index its number),
    // their geometries and each geometry's index count: one draw each.
    NRI_INTEROP_API int Nri_GetDonutSceneInstanceCount(DonutScene* scene)
    {
        return int(scene->instances.size());
    }

    NRI_INTEROP_API int Nri_GetDonutSceneInstanceGeometryCount(DonutScene* scene, int instance)
    {
        return int(scene->instances[size_t(instance)].numGeometries);
    }

    NRI_INTEROP_API int Nri_GetDonutSceneGeometryIndexCount(DonutScene* scene, int instance, int geometry)
    {
        return int(scene->geometries[scene->instances[size_t(instance)].firstGeometryIndex + uint32_t(geometry)].numIndices);
    }
}

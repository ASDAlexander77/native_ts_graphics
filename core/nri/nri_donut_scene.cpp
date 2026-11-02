// A glTF scene as Donut's engine loads it (GltfImporter, SceneGraph, Scene), for the NRI ports of the
// Donut examples that draw Donut scenes (examples/nri/bindless_rendering_nri.ts,
// threaded_rendering_nri.ts): the scene buffers Donut's scene shaders read (donut/shaders/bindless.h's
// InstanceData and GeometryData, material_cb.h's MaterialConstants), the vertices as Donut's
// BufferGroup holds them (each attribute's stream after the other: positions, texture coordinates,
// snorm8 normals and tangents, the tangents generated as GltfImporter generates the missing ones)
// and the indices, with Donut's own math for the node transforms, so the ports draw the same pixels.
// The materials' textures are numbered in the order the materials first use them (Donut numbers
// them as its loader threads finish: the shaders only follow the numbers). Not imported: skins,
// curves, second texture coordinates, lights, cameras. A translation unit of its own, as
// nri_donut_constants.cpp.

#include <donut/core/math/math.h>

#include <cstdio>
#include <array>
#include <cmath>
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
extern "C" NRI_INTEROP_API void* Nri_CreateHostBuffer(void* device, int byteSize, int usage);
extern "C" NRI_INTEROP_API void* Nri_CreateUploadedBufferFromInts(void* device, void* queue, const void* data, int byteSize, int usage);
extern "C" NRI_INTEROP_API void Nri_WriteBuffer(void* buffer, int offset, const void* data, int byteSize);
extern "C" NRI_INTEROP_API void* Nri_CreateBlasDesc();
extern "C" NRI_INTEROP_API void Nri_DestroyBlasDesc(void* desc);
extern "C" NRI_INTEROP_API void Nri_BlasDescAddTriangles(void* desc, const float* vertices, int vertexNum, const uint32_t* indices, int indexNum);
extern "C" NRI_INTEROP_API void* Nri_BuildBlasFromDesc(void* device, void* queue, void* desc, int flags);
extern "C" NRI_INTEROP_API void Nri_DestroyAccelerationStructure(void* accelerationStructure);
extern "C" NRI_INTEROP_API void* Nri_CreateTopLevelAS(void* device, int instanceMaxNum, int flags, int bufferNum);
extern "C" NRI_INTEROP_API void Nri_TopLevelASAddInstance(void* tlas, void* blas, const float* transform, int instanceId, int mask,
    int hitGroupOffset, int flags);
extern "C" NRI_INTEROP_API int Nri_BuildTopLevelASOnQueue(void* queue, void* tlas);
extern "C" NRI_INTEROP_API void Nri_DestroyTopLevelAS(void* tlas);

namespace
{
    // A material's texture slots, as the G-buffer and forward passes bind them (t0 to t6).
    enum MaterialTexture
    {
        MaterialTexture_BaseOrDiffuse,
        MaterialTexture_MetalRoughOrSpecular,
        MaterialTexture_Normal,
        MaterialTexture_Emissive,
        MaterialTexture_Occlusion,
        MaterialTexture_Transmission,
        MaterialTexture_Opacity,
        MaterialTexture_Count
    };

    // The vertex streams, one after the other in the vertex buffer.
    enum VertexStream
    {
        VertexStream_Position,
        VertexStream_TexCoord,
        VertexStream_Normal,
        VertexStream_Tangent,
        VertexStream_Count
    };

    struct DonutScene
    {
        // The mesh buffers: Donut's BufferGroup of the file (the vertex buffer's streams one after
        // the other, 32-bit words), its bindless buffer numbers 0 (vertices) and 1 (indices, each
        // geometry's from its first vertex).
        std::vector<uint32_t> vertices;
        uint32_t streamOffsets[VertexStream_Count] = {};
        std::vector<uint32_t> indices;
        std::vector<InstanceData> instances;
        std::vector<GeometryData> geometries;
        // Each geometry's first vertex in the streams (GeometryData has their byte offsets).
        std::vector<uint32_t> firstVertices;
        std::vector<MaterialConstants> materials;
        // Each material's textures by slot (-1: none), and whether it's double-sided.
        std::vector<std::array<int, MaterialTexture_Count>> materialTextures;
        std::vector<bool> materialDoubleSided;
        // The textures' files (relative to the library's folder) and whether they're sRGB, in texture
        // number order.
        std::vector<std::string> textures;
        std::vector<bool> textureSrgb;
        // The root node's global bounding box (SceneGraph's): each mesh instance's mesh bounds in
        // world space, as the node's float transform takes them.
        box3 bounds = box3::empty();
        // Each mesh's object-space bounds (MeshInfo::objectSpaceBounds).
        std::vector<box3> meshBounds;
    };


    // MaterialConstants as Material::FillConstantBuffer fills them from a material GltfImporter
    // imports (its textures by slot, numbered, -1 for none), or Donut's default material (null).
    MaterialConstants ImportMaterial(const cgltf_material* material, const std::array<int, MaterialTexture_Count>& textures)
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
        float transmissionFactor = 0.f;
        float2 normalTextureTransformScale = 1.f;
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
            if (material->has_transmission)
                transmissionFactor = material->transmission.transmission_factor;
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
            if (material->normal_texture.has_transform)
                normalTextureTransformScale = float2(material->normal_texture.transform.scale[0], material->normal_texture.transform.scale[1]);
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
        const int flags[MaterialTexture_Count] = { MaterialFlags_UseBaseOrDiffuseTexture, MaterialFlags_UseMetalRoughOrSpecularTexture,
            MaterialFlags_UseNormalTexture, MaterialFlags_UseEmissiveTexture, MaterialFlags_UseOcclusionTexture,
            MaterialFlags_UseTransmissionTexture, MaterialFlags_UseOpacityTexture };
        for (int slot = 0; slot < MaterialTexture_Count; slot++)
            if (textures[slot] >= 0)
                constants.flags |= flags[slot];
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
        constants.transmissionFactor = transmissionFactor;
        constants.normalTextureTransformScale = normalTextureTransformScale;
        const bool blended = domain == MaterialDomain_AlphaBlended || domain == MaterialDomain_TransmissiveAlphaBlended;
        const bool tested = domain == MaterialDomain_AlphaTested || domain == MaterialDomain_TransmissiveAlphaTested;
        constants.opacity = blended ? opacity : 1.f;
        constants.alphaCutoff = tested ? alphaCutoff : blended ? 0.f : -1.f;
        // Bindless descriptors: the texture numbers.
        constants.baseOrDiffuseTextureIndex = textures[MaterialTexture_BaseOrDiffuse];
        constants.metalRoughOrSpecularTextureIndex = textures[MaterialTexture_MetalRoughOrSpecular];
        constants.normalTextureIndex = textures[MaterialTexture_Normal];
        constants.emissiveTextureIndex = textures[MaterialTexture_Emissive];
        constants.occlusionTextureIndex = textures[MaterialTexture_Occlusion];
        constants.transmissionTextureIndex = textures[MaterialTexture_Transmission];
        constants.opacityTextureIndex = textures[MaterialTexture_Opacity];
        return constants;
    }

    // GltfImporter's tangents for a primitive without them: each triangle's tangent and bitangent
    // from its texture coordinates, normalized, summed per vertex, normalized again, the sign from the
    // normal; snorm8-packed.
    void GenerateTangents(const float* positions, const float* texCoords, const float3* normals, size_t count, const uint32_t* indices,
        size_t indexCount, uint32_t* tangentWords)
    {
        std::vector<float3> computedTangents(count, float3(0.f));
        std::vector<float3> computedBitangents(count, float3(0.f));
        for (size_t t_idx = 0; t_idx < indexCount / 3; t_idx++)
        {
            uint3 tri = indices;
            indices += 3;

            float3 p0 = positions + tri.x * 3;
            float3 p1 = positions + tri.y * 3;
            float3 p2 = positions + tri.z * 3;

            float2 t0 = texCoords + tri.x * 2;
            float2 t1 = texCoords + tri.y * 2;
            float2 t2 = texCoords + tri.z * 2;

            float3 dPds = p1 - p0;
            float3 dPdt = p2 - p0;

            float2 dTds = t1 - t0;
            float2 dTdt = t2 - t0;
            float r = 1.0f / (dTds.x * dTdt.y - dTds.y * dTdt.x);
            float3 tangent = r * (dPds * dTdt.y - dPdt * dTds.y);
            float3 bitangent = r * (dPdt * dTds.x - dPds * dTdt.x);

            float tangentLength = length(tangent);
            float bitangentLength = length(bitangent);
            if (tangentLength > 0 && bitangentLength > 0)
            {
                tangent /= tangentLength;
                bitangent /= bitangentLength;

                computedTangents[tri.x] += tangent;
                computedTangents[tri.y] += tangent;
                computedTangents[tri.z] += tangent;
                computedBitangents[tri.x] += bitangent;
                computedBitangents[tri.y] += bitangent;
                computedBitangents[tri.z] += bitangent;
            }
        }

        for (size_t v_idx = 0; v_idx < count; v_idx++)
        {
            float3 normal = normals[v_idx];
            float3 tangent = computedTangents[v_idx];
            float3 bitangent = computedBitangents[v_idx];

            float sign = 0;
            float tangentLength = length(tangent);
            float bitangentLength = length(bitangent);
            if (tangentLength > 0 && bitangentLength > 0)
            {
                tangent /= tangentLength;
                bitangent /= bitangentLength;
                float3 cross_b = cross(normal, tangent);
                sign = (dot(cross_b, bitangent) > 0) ? -1.f : 1.f;
            }

            tangentWords[v_idx] = vectorToSnorm8(float4(tangent, sign));
        }
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
            scene.bounds |= scene.meshBounds[mesh] * affine3(localToWorld);
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
        // TextureCache keys by file: an image used as sRGB and as linear keeps its first use's.
        std::map<const cgltf_image*, int> textureNumbers;
        auto textureNumber = [&](const cgltf_texture* texture, bool sRGB) -> int {
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
            scene.textureSrgb.push_back(sRGB);
            textureNumbers[texture->image] = number;
            return number;
        };
        // GltfImporter's load_texture calls, in its order, with their sRGB modes.
        auto materialTextures = [&](const cgltf_material* material) {
            std::array<int, MaterialTexture_Count> textures;
            textures.fill(-1);
            if (!material)
                return textures;
            if (material->has_pbr_specular_glossiness)
            {
                textures[MaterialTexture_BaseOrDiffuse] = textureNumber(material->pbr_specular_glossiness.diffuse_texture.texture, true);
                textures[MaterialTexture_MetalRoughOrSpecular] =
                    textureNumber(material->pbr_specular_glossiness.specular_glossiness_texture.texture, true);
            }
            else if (material->has_pbr_metallic_roughness)
            {
                textures[MaterialTexture_BaseOrDiffuse] = textureNumber(material->pbr_metallic_roughness.base_color_texture.texture, true);
                textures[MaterialTexture_MetalRoughOrSpecular] =
                    textureNumber(material->pbr_metallic_roughness.metallic_roughness_texture.texture, false);
            }
            if (material->has_transmission)
                textures[MaterialTexture_Transmission] = textureNumber(material->transmission.transmission_texture.texture, false);
            textures[MaterialTexture_Emissive] = textureNumber(material->emissive_texture.texture, true);
            textures[MaterialTexture_Normal] = textureNumber(material->normal_texture.texture, false);
            textures[MaterialTexture_Occlusion] = textureNumber(material->occlusion_texture.texture, false);
            return textures;
        };

        // The materials, then Donut's default material for primitives without one.
        std::map<const cgltf_material*, uint32_t> materialIDs;
        for (size_t i = 0; i < data->materials_count; i++)
        {
            materialIDs[&data->materials[i]] = uint32_t(scene.materials.size());
            const std::array<int, MaterialTexture_Count> textures = materialTextures(&data->materials[i]);
            scene.materials.push_back(ImportMaterial(&data->materials[i], textures));
            scene.materialTextures.push_back(textures);
            scene.materialDoubleSided.push_back(data->materials[i].double_sided);
        }
        uint32_t defaultMaterial = ~0u;

        // The meshes' geometries (triangle lists), their vertices and indices one after another.
        std::vector<float> positions3;
        std::vector<float> texCoords2;
        std::vector<uint32_t> normalWords;
        std::vector<uint32_t> tangentWords;
        std::vector<uint32_t> firstGeometry;
        size_t vertexCount = 0;
        for (size_t m = 0; m < data->meshes_count; m++)
        {
            firstGeometry.push_back(uint32_t(scene.geometries.size()));
            scene.meshBounds.push_back(box3::empty());
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
                const cgltf_accessor* normals = nullptr;
                const cgltf_accessor* tangents = nullptr;
                for (size_t a = 0; a < primitive.attributes_count; a++)
                {
                    const cgltf_attribute& attribute = primitive.attributes[a];
                    if (attribute.type == cgltf_attribute_type_position)
                        positions = attribute.data;
                    else if (attribute.type == cgltf_attribute_type_texcoord && attribute.index == 0)
                        uvs = attribute.data;
                    else if (attribute.type == cgltf_attribute_type_normal)
                        normals = attribute.data;
                    else if (attribute.type == cgltf_attribute_type_tangent)
                        tangents = attribute.data;
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
                // (The streams' starts added once all the vertices are in.)
                geometry.positionOffset = uint32_t(vertexCount * sizeof(float3));
                geometry.prevPositionOffset = ~0u;
                geometry.texCoord1Offset = uint32_t(vertexCount * sizeof(float2));
                geometry.texCoord2Offset = ~0u;
                geometry.normalOffset = uint32_t(vertexCount * sizeof(uint32_t));
                geometry.tangentOffset = uint32_t(vertexCount * sizeof(uint32_t));
                geometry.curveRadiusOffset = ~0u;
                if (primitive.material)
                    geometry.materialIndex = materialIDs[primitive.material];
                else
                {
                    if (defaultMaterial == ~0u)
                    {
                        defaultMaterial = uint32_t(scene.materials.size());
                        std::array<int, MaterialTexture_Count> none;
                        none.fill(-1);
                        scene.materials.push_back(ImportMaterial(nullptr, none));
                        scene.materialTextures.push_back(none);
                        scene.materialDoubleSided.push_back(false);
                    }
                    geometry.materialIndex = defaultMaterial;
                }

                // Indices as GltfImporter copies them (or 0, 1, 2... without), relative to the
                // geometry's first vertex.
                const size_t firstIndex = scene.indices.size();
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

                const size_t count = positions->count;
                const size_t firstPosition = positions3.size();
                positions3.resize(firstPosition + count * 3, 0.f);
                for (size_t v = 0; v < count; v++)
                {
                    cgltf_accessor_read_float(positions, v, &positions3[firstPosition + v * 3], 3);
                    scene.meshBounds.back() |= float3(&positions3[firstPosition + v * 3]);
                }
                const size_t firstTexCoord = texCoords2.size();
                texCoords2.resize(firstTexCoord + count * 2, 0.f);
                if (uvs)
                    for (size_t v = 0; v < count && v < uvs->count; v++)
                        cgltf_accessor_read_float(uvs, v, &texCoords2[firstTexCoord + v * 2], 2);
                std::vector<float3> normalVectors(count, float3(0.f));
                if (normals)
                    for (size_t v = 0; v < count && v < normals->count; v++)
                        cgltf_accessor_read_float(normals, v, &normalVectors[v].x, 3);
                const size_t firstNormal = normalWords.size();
                normalWords.resize(firstNormal + count, 0);
                tangentWords.resize(firstNormal + count, 0);
                if (normals)
                    for (size_t v = 0; v < count; v++)
                        normalWords[firstNormal + v] = vectorToSnorm8(normalVectors[v]);
                if (tangents)
                    for (size_t v = 0; v < count && v < tangents->count; v++)
                    {
                        float4 tangent = 0.f;
                        cgltf_accessor_read_float(tangents, v, &tangent.x, 4);
                        tangentWords[firstNormal + v] = vectorToSnorm8(tangent);
                    }
                else if (normals && uvs)
                    GenerateTangents(&positions3[firstPosition], &texCoords2[firstTexCoord], normalVectors.data(), count,
                        &scene.indices[firstIndex], scene.indices.size() - firstIndex, &tangentWords[firstNormal]);

                scene.firstVertices.push_back(uint32_t(vertexCount));
                vertexCount += count;
                scene.geometries.push_back(geometry);
            }
        }

        // The streams one after the other.
        auto appendFloats = [&scene](const std::vector<float>& values) {
            const size_t start = scene.vertices.size();
            scene.vertices.resize(start + values.size());
            if (!values.empty())
                memcpy(&scene.vertices[start], values.data(), values.size() * sizeof(float));
        };
        scene.streamOffsets[VertexStream_Position] = 0;
        appendFloats(positions3);
        scene.streamOffsets[VertexStream_TexCoord] = uint32_t(scene.vertices.size() * 4);
        appendFloats(texCoords2);
        scene.streamOffsets[VertexStream_Normal] = uint32_t(scene.vertices.size() * 4);
        scene.vertices.insert(scene.vertices.end(), normalWords.begin(), normalWords.end());
        scene.streamOffsets[VertexStream_Tangent] = uint32_t(scene.vertices.size() * 4);
        scene.vertices.insert(scene.vertices.end(), tangentWords.begin(), tangentWords.end());
        for (GeometryData& geometry : scene.geometries)
        {
            geometry.texCoord1Offset += scene.streamOffsets[VertexStream_TexCoord];
            geometry.normalOffset += scene.streamOffsets[VertexStream_Normal];
            geometry.tangentOffset += scene.streamOffsets[VertexStream_Tangent];
        }

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
    // (Nri_CreateUploadedStructuredBuffer's); 5 the indices as an index buffer (32-bit); 6 the
    // InstanceData as a ByteAddressBuffer (D3D11's shaders read them so); null on failure.
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
        case 5: return Nri_CreateUploadedBufferFromInts(device, queue, scene->indices.data(), int(scene->indices.size() * 4), 1);
        case 6: return Nri_CreateUploadedStructuredBuffer(device, queue, scene->instances.data(),
            int(scene->instances.size() * sizeof(InstanceData)), 4);
        default: return nullptr;
        }
    }

    // The materials' MaterialConstants, each in a constant buffer view's 256 bytes (material m at m *
    // 256), in a host buffer (Nri_CreateHostBuffer's): the forward and G-buffer passes' per-material
    // constants. Null on failure.
    NRI_INTEROP_API void* Nri_CreateDonutSceneMaterialBuffer(void* device, DonutScene* scene)
    {
        static_assert(sizeof(MaterialConstants) <= 256, "a material's constants take more than 256 bytes");
        void* buffer = Nri_CreateHostBuffer(device, int(scene->materials.size() * 256), 2);
        if (!buffer)
            return nullptr;
        for (size_t m = 0; m < scene->materials.size(); m++)
            Nri_WriteBuffer(buffer, int(m * 256), &scene->materials[m], int(sizeof(MaterialConstants)));
        return buffer;
    }

    // The materials: their count, each's texture in a slot (0 base or diffuse, 1 metal-rough or
    // specular, 2 normal, 3 emissive, 4 occlusion, 5 transmission, 6 opacity; -1 for none), its
    // domain (MaterialDomain_*: 0 opaque, 1 alpha-tested, 2 alpha-blended...) and whether it's
    // double-sided (Donut draws those without culling).
    NRI_INTEROP_API int Nri_GetDonutSceneMaterialCount(DonutScene* scene)
    {
        return int(scene->materials.size());
    }

    NRI_INTEROP_API int Nri_GetDonutSceneMaterialTexture(DonutScene* scene, int material, int slot)
    {
        return scene->materialTextures[size_t(material)][size_t(slot)];
    }

    NRI_INTEROP_API int Nri_GetDonutSceneMaterialDomain(DonutScene* scene, int material)
    {
        return scene->materials[size_t(material)].domain;
    }

    NRI_INTEROP_API int Nri_GetDonutSceneMaterialDoubleSided(DonutScene* scene, int material)
    {
        return scene->materialDoubleSided[size_t(material)] ? 1 : 0;
    }

    // The textures (their files relative to the library's folder; sRGB or linear), by number.
    NRI_INTEROP_API int Nri_GetDonutSceneTextureCount(DonutScene* scene)
    {
        return int(scene->textures.size());
    }

    NRI_INTEROP_API const char* Nri_GetDonutSceneTexturePath(DonutScene* scene, int texture)
    {
        return scene->textures[size_t(texture)].c_str();
    }

    NRI_INTEROP_API int Nri_GetDonutSceneTextureSrgb(DonutScene* scene, int texture)
    {
        return scene->textureSrgb[size_t(texture)] ? 1 : 0;
    }

    // The scene's bounds (SceneGraph's root's global bounding box): 6 floats, min x, y, z, max x, y, z.
    NRI_INTEROP_API void Nri_GetDonutSceneBounds(DonutScene* scene, float* dst)
    {
        memcpy(dst, &scene->bounds.m_mins, sizeof(float) * 3);
        memcpy(dst + 3, &scene->bounds.m_maxs, sizeof(float) * 3);
    }

    // The byte offset of a vertex stream in the vertex buffer: 0 positions (float3), 1 texture
    // coordinates (float2), 2 normals, 3 tangents (snorm8 each).
    NRI_INTEROP_API int Nri_GetDonutSceneStreamOffset(DonutScene* scene, int stream)
    {
        return int(scene->streamOffsets[size_t(stream)]);
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

    // A geometry's first index in the index buffer, its first vertex in the streams (its indices count
    // from it) and its material.
    NRI_INTEROP_API int Nri_GetDonutSceneGeometryFirstIndex(DonutScene* scene, int instance, int geometry)
    {
        return int(scene->geometries[scene->instances[size_t(instance)].firstGeometryIndex + uint32_t(geometry)].indexOffset / 4);
    }

    NRI_INTEROP_API int Nri_GetDonutSceneGeometryFirstVertex(DonutScene* scene, int instance, int geometry)
    {
        return int(scene->firstVertices[scene->instances[size_t(instance)].firstGeometryIndex + uint32_t(geometry)]);
    }

    NRI_INTEROP_API int Nri_GetDonutSceneGeometryMaterial(DonutScene* scene, int instance, int geometry)
    {
        return int(scene->geometries[scene->instances[size_t(instance)].firstGeometryIndex + uint32_t(geometry)].materialIndex);
    }

    // The scene's acceleration structures as Donut_BuildSceneAccelStructs builds them (nri_interop's
    // TLAS and the BLASes it references).
    struct DonutSceneAccelStructs
    {
        std::vector<void*> blases;
        void* tlas = nullptr;
    };

    NRI_INTEROP_API void Nri_DestroyDonutSceneAccelStructs(DonutSceneAccelStructs* accelStructs);

    // As Donut_BuildSceneAccelStructs: a BLAS per mesh (each geometry's opaque triangles, its
    // positions and indices), a TLAS of the mesh instances (their transforms, mask 1, instance ID and
    // hit group offset 0, no flags), built on the queue (which this waits for); null on failure.
    NRI_INTEROP_API DonutSceneAccelStructs* Nri_BuildDonutSceneAccelStructs(void* device, void* queue, DonutScene* scene)
    {
        auto* accelStructs = new DonutSceneAccelStructs();
        // A mesh's BLAS, by its first geometry (the instances of a mesh share it).
        std::map<uint32_t, void*> meshBlases;
        const float* positions = (const float*)scene->vertices.data() + scene->streamOffsets[VertexStream_Position] / 4;
        for (const InstanceData& instance : scene->instances)
        {
            if (instance.numGeometries == 0 || meshBlases.count(instance.firstGeometryIndex))
                continue;
            void* desc = Nri_CreateBlasDesc();
            for (uint32_t g = instance.firstGeometryIndex; g < instance.firstGeometryIndex + instance.numGeometries; g++)
            {
                const GeometryData& geometry = scene->geometries[g];
                Nri_BlasDescAddTriangles(desc, positions + size_t(scene->firstVertices[g]) * 3, int(geometry.numVertices),
                    scene->indices.data() + geometry.indexOffset / 4, int(geometry.numIndices));
            }
            void* blas = Nri_BuildBlasFromDesc(device, queue, desc, 0);
            Nri_DestroyBlasDesc(desc);
            if (!blas)
            {
                Nri_DestroyDonutSceneAccelStructs(accelStructs);
                return nullptr;
            }
            meshBlases[instance.firstGeometryIndex] = blas;
            accelStructs->blases.push_back(blas);
        }

        accelStructs->tlas = Nri_CreateTopLevelAS(device, int(scene->instances.size()), 0, 1);
        if (!accelStructs->tlas)
        {
            Nri_DestroyDonutSceneAccelStructs(accelStructs);
            return nullptr;
        }
        for (const InstanceData& instance : scene->instances)
        {
            if (instance.numGeometries == 0)
                continue;
            // affineToColumnMajor's float3x4, as NVRHI's AffineTransform takes it.
            float transform[12];
            memcpy(transform, &instance.transform, sizeof(transform));
            Nri_TopLevelASAddInstance(accelStructs->tlas, meshBlases[instance.firstGeometryIndex], transform, 0, 1, 0, 0);
        }
        if (!Nri_BuildTopLevelASOnQueue(queue, accelStructs->tlas))
        {
            Nri_DestroyDonutSceneAccelStructs(accelStructs);
            return nullptr;
        }
        return accelStructs;
    }

    // The TLAS (an NriTopLevelASHandle), valid as long as the structures.
    NRI_INTEROP_API void* Nri_GetDonutSceneTopLevelAS(DonutSceneAccelStructs* accelStructs)
    {
        return accelStructs->tlas;
    }

    NRI_INTEROP_API void Nri_DestroyDonutSceneAccelStructs(DonutSceneAccelStructs* accelStructs)
    {
        if (accelStructs->tlas)
            Nri_DestroyTopLevelAS(accelStructs->tlas);
        for (void* blas : accelStructs->blases)
            Nri_DestroyAccelerationStructure(blas);
        delete accelStructs;
    }
}

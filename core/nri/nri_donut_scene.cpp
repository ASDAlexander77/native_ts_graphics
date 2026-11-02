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
#include <algorithm>
#include <cstdlib>

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
extern "C" NRI_INTEROP_API void Nri_BlasDescSetOpaque(void* desc, int opaque);
extern "C" NRI_INTEROP_API void Nri_TopLevelASClearInstances(void* tlas);
extern "C" NRI_INTEROP_API void Nri_CmdBuildTopLevelAS(void* commandBuffer, void* tlas, int bufferIndex, int update);
extern "C" NRI_INTEROP_API void* Nri_CreateBufferBlas(int flags);
extern "C" NRI_INTEROP_API void Nri_BufferBlasAddTriangles(void* blas, int vertexOffset, int vertexNum, const uint32_t* indices, int indexNum,
    int opaque);
extern "C" NRI_INTEROP_API int Nri_BufferBlasCreate(void* device, void* blas);
extern "C" NRI_INTEROP_API void Nri_CmdBuildBufferBlas(void* commandBuffer, void* blas, void* vertexBuffer);
extern "C" NRI_INTEROP_API void* Nri_GetBufferBlasAccelerationStructure(void* blas);
extern "C" NRI_INTEROP_API void Nri_DestroyBufferBlas(void* blas);

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

namespace
{
    // nri::AccelerationStructureBits: Donut's static BLASes are PreferFastTrace | AllowCompaction, its
    // skinned ones PreferFastTrace.
    const int BLAS_ALLOW_COMPACTION = 2;
    const int BLAS_PREFER_FAST_TRACE = 32;

    uint32_t AlignTo16(uint32_t size)
    {
        return (size + 15u) & ~15u;
    }

    // A JSON value, as much of JSON as scene files use (jsoncpp's, in Donut).
    struct JsonValue
    {
        enum Type { Null, Bool, Number, String, Array, Object };
        Type type = Null;
        bool boolean = false;
        double number = 0.0;
        std::string string;
        std::vector<JsonValue> items;
        std::vector<std::pair<std::string, JsonValue>> members;

        const JsonValue* Find(const char* key) const
        {
            for (const auto& member : members)
                if (member.first == key)
                    return &member.second;
            return nullptr;
        }
    };

    struct JsonParser
    {
        const char* p = nullptr;
        const char* end = nullptr;

        void Skip()
        {
            while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r'))
                p++;
        }

        bool ParseString(std::string& s)
        {
            if (p >= end || *p != '"')
                return false;
            p++;
            while (p < end && *p != '"')
            {
                if (*p == '\\' && p + 1 < end)
                {
                    p++;
                    const char e = *p++;
                    s += e == 'n' ? '\n' : e == 't' ? '\t' : e == 'r' ? '\r' : e;
                }
                else
                    s += *p++;
            }
            if (p >= end)
                return false;
            p++;
            return true;
        }

        bool Parse(JsonValue& v)
        {
            Skip();
            if (p >= end)
                return false;
            if (*p == '{')
            {
                p++;
                v.type = JsonValue::Object;
                Skip();
                if (p < end && *p == '}')
                {
                    p++;
                    return true;
                }
                for (;;)
                {
                    Skip();
                    std::string key;
                    if (!ParseString(key))
                        return false;
                    Skip();
                    if (p >= end || *p != ':')
                        return false;
                    p++;
                    JsonValue value;
                    if (!Parse(value))
                        return false;
                    v.members.emplace_back(key, std::move(value));
                    Skip();
                    if (p < end && *p == ',')
                    {
                        p++;
                        continue;
                    }
                    if (p < end && *p == '}')
                    {
                        p++;
                        return true;
                    }
                    return false;
                }
            }
            if (*p == '[')
            {
                p++;
                v.type = JsonValue::Array;
                Skip();
                if (p < end && *p == ']')
                {
                    p++;
                    return true;
                }
                for (;;)
                {
                    JsonValue item;
                    if (!Parse(item))
                        return false;
                    v.items.push_back(std::move(item));
                    Skip();
                    if (p < end && *p == ',')
                    {
                        p++;
                        continue;
                    }
                    if (p < end && *p == ']')
                    {
                        p++;
                        return true;
                    }
                    return false;
                }
            }
            if (*p == '"')
            {
                v.type = JsonValue::String;
                return ParseString(v.string);
            }
            if (end - p >= 4 && strncmp(p, "true", 4) == 0)
            {
                v.type = JsonValue::Bool;
                v.boolean = true;
                p += 4;
                return true;
            }
            if (end - p >= 5 && strncmp(p, "false", 5) == 0)
            {
                v.type = JsonValue::Bool;
                p += 5;
                return true;
            }
            if (end - p >= 4 && strncmp(p, "null", 4) == 0)
            {
                p += 4;
                return true;
            }
            char* numberEnd = nullptr;
            v.number = strtod(p, &numberEnd);
            if (numberEnd == p)
                return false;
            v.type = JsonValue::Number;
            p = numberEnd;
            return true;
        }
    };

    // donut::json::Read<double3> and <double4>: an array of 3 (4), or a number for all the components.
    double3 ReadDouble3(const JsonValue& v, const double3& defaultValue)
    {
        if (v.type == JsonValue::Array && v.items.size() == 3)
            return double3(v.items[0].number, v.items[1].number, v.items[2].number);
        if (v.type == JsonValue::Number)
            return double3(v.number);
        return defaultValue;
    }

    double4 ReadDouble4(const JsonValue& v, const double4& defaultValue)
    {
        if (v.type == JsonValue::Array && v.items.size() == 4)
            return double4(v.items[0].number, v.items[1].number, v.items[2].number, v.items[3].number);
        if (v.type == JsonValue::Number)
            return double4(v.number);
        return defaultValue;
    }

    // animation::Keyframe, animation::Sampler (KeyframeAnimation.cpp): keyframes sorted by time,
    // evaluated with the last values extrapolated.
    enum class Interpolation { Step, Linear, Slerp, HermiteSpline };

    struct Keyframe
    {
        float time = 0.f;
        float4 value = 0.f;
        float4 inTangent = 0.f;
        float4 outTangent = 0.f;
    };

    struct AnimationSampler
    {
        Interpolation mode = Interpolation::Step;
        std::vector<Keyframe> keyframes;

        float EndTime() const
        {
            return keyframes.empty() ? 0.f : keyframes.back().time;
        }

        static float4 Interpolate(Interpolation mode, const Keyframe& b, const Keyframe& c, float t, float dt)
        {
            switch (mode)
            {
            case Interpolation::Linear:
                return lerp(b.value, c.value, t);
            case Interpolation::Slerp: {
                quat qb = quat::fromXYZW(b.value);
                quat qc = quat::fromXYZW(c.value);
                quat qr = slerp(qb, qc, t);
                return float4(qr.x, qr.y, qr.z, qr.w);
            }
            case Interpolation::HermiteSpline: {
                const float t2 = t * t;
                const float t3 = t2 * t;
                return (2.f * t3 - 3.f * t2 + 1.f) * b.value
                     + (t3 - 2.f * t2 + t) * b.outTangent * dt
                     + (-2.f * t3 + 3.f * t2) * c.value
                     + (t3 - t2) * c.inTangent * dt;
            }
            case Interpolation::Step:
            default:
                return b.value;
            }
        }

        bool Evaluate(float time, float4& result) const
        {
            const size_t count = keyframes.size();
            if (count == 0)
                return false;
            if (time <= keyframes[0].time)
            {
                result = keyframes[0].value;
                return true;
            }
            if (count == 1 || time >= keyframes[count - 1].time)
            {
                result = keyframes[count - 1].value;
                return true;
            }
            size_t left = 0;
            size_t right = count - 2;
            while (left <= right)
            {
                const size_t middle = (left + right) / 2;
                const float tb = keyframes[middle].time;
                const float tc = keyframes[middle + 1].time;
                if (time < tb)
                    right = middle - 1;
                else if (time >= tc)
                    left = middle + 1;
                else
                {
                    left = right = middle;
                    break;
                }
            }
            const Keyframe& b = keyframes[left];
            const Keyframe& c = keyframes[left + 1];
            if (time < b.time || time >= c.time)
                return false;
            const float dt = c.time - b.time;
            const float u = (time - b.time) / dt;
            result = Interpolate(mode, b, c, u, dt);
            return true;
        }
    };

    enum AnimationAttribute { Attribute_Translation, Attribute_Rotation, Attribute_Scaling };

    // A model (a glTF file): its meshes, buffers and materials as LoadScene imports them, its skinned
    // vertices' joint indices and weights (GltfImporter's jointData, weightData), its skins and
    // animations; the cgltf data kept for its node tree.
    struct ModelMesh
    {
        // Model-local: the first geometry, the first vertex (MeshInfo::vertexOffset).
        uint32_t firstGeometry = 0;
        uint32_t geometryCount = 0;
        uint32_t vertexOffset = 0;
        uint32_t totalVertices = 0;
    };

    struct ModelAnimation
    {
        struct Channel
        {
            int sampler = 0;
            size_t gltfNode = 0;
            AnimationAttribute attribute = Attribute_Translation;
        };
        std::vector<Channel> channels;
        float duration = 0.f;
    };

    struct Model
    {
        DonutScene scene;
        std::unique_ptr<cgltf_data, void (*)(cgltf_data*)> data{ nullptr, cgltf_free };
        std::vector<ModelMesh> meshes;
        bool hasJoints = false;
        // Per vertex: the 4 joint indices as 16 bits each (2 words), the 4 weights.
        std::vector<uint32_t> jointWords;
        std::vector<float> weights;
        std::vector<AnimationSampler> samplers;
        std::vector<ModelAnimation> animations;
        // Where it went in the merged scene: its vertex streams (bytes), its joint indices and weights
        // (bytes), its first index, material, texture and geometry.
        uint32_t streamBytes[VertexStream_Count] = {};
        uint32_t jointBytes = 0;
        uint32_t weightBytes = 0;
        uint32_t firstIndex = 0;
        uint32_t firstMaterial = 0;
        uint32_t firstTexture = 0;
        uint32_t firstGeometry = 0;
        // Its first instance's root node (-1: not instanced yet).
        int firstRoot = -1;
    };

    // A scene graph node (SceneGraphNode): its TRS, whether it has one (m_HasLocalTransform), its
    // global transform (double, and in floats).
    struct GraphNode
    {
        int parent = -1;
        bool hasLocalTransform = false;
        double3 translation = 0.0;
        dquat rotation = dquat::identity();
        double3 scaling = 1.0;
        daffine3 global = daffine3::identity();
        affine3 globalFloat = affine3::identity();
    };

    struct MeshInstanceInfo
    {
        int node = 0;
        int model = 0;
        int mesh = 0;
        uint32_t firstGeometry = 0;
        uint32_t geometryCount = 0;
        // Its SkinnedMeshInstance (-1: a MeshInstance).
        int skinned = -1;
    };

    struct SkinnedInstanceInfo
    {
        int instance = 0;
        // The joints' nodes and inverse bind matrices.
        std::vector<int> jointNodes;
        std::vector<float4x4> inverseBindMatrices;
        std::vector<float4x4> jointMatrices;
        // Its vertices in the skinned vertex buffer (Donut's SkinnedVertexBuffer ranges, 16-byte aligned).
        uint32_t positionBytes = 0;
        uint32_t prevPositionBytes = 0;
        uint32_t normalBytes = 0;
        uint32_t tangentBytes = 0;
        uint32_t texCoordBytes = 0;
        bool initialized = false;
    };

    struct AnimationInstance
    {
        struct Channel
        {
            const AnimationSampler* sampler = nullptr;
            int node = 0;
            AnimationAttribute attribute = Attribute_Translation;
        };
        std::vector<Channel> channels;
        float duration = 0.f;
    };

    struct DonutAnimatedScene
    {
        DonutScene merged;
        std::vector<std::unique_ptr<Model>> models;
        std::vector<GraphNode> nodes;
        std::vector<MeshInstanceInfo> instances;
        std::vector<SkinnedInstanceInfo> skinned;
        std::vector<AnimationInstance> animations;
        // Each global geometry's first position (in merged.vertices' words; static geometries).
        std::vector<uint32_t> positionWords;
        uint32_t skinnedVertexBytes = 0;
        bool refreshed = false;
    };

    std::unique_ptr<Model> LoadModel(const std::string& path)
    {
        auto model = std::make_unique<Model>();
        if (!LoadScene(path.c_str(), model->scene))
            return nullptr;
        const std::string fileName = NriLibraryPath(path.c_str());
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
            return nullptr;
        }
        model->data.reset(data);

        // The meshes (LoadScene's geometries, mesh after mesh), and the joint indices and weights of
        // their vertices (zero for vertices without), as GltfImporter reads them.
        uint32_t geometry = 0;
        for (size_t m = 0; m < data->meshes_count; m++)
        {
            ModelMesh mesh;
            mesh.firstGeometry = geometry;
            mesh.geometryCount = uint32_t(data->meshes[m].primitives_count);
            mesh.vertexOffset = mesh.geometryCount > 0 ? model->scene.firstVertices[geometry] : 0;
            for (size_t p = 0; p < data->meshes[m].primitives_count; p++)
            {
                const cgltf_primitive& primitive = data->meshes[m].primitives[p];
                const cgltf_accessor* joints = nullptr;
                const cgltf_accessor* weights = nullptr;
                for (size_t a = 0; a < primitive.attributes_count; a++)
                {
                    if (primitive.attributes[a].type == cgltf_attribute_type_joints)
                        joints = primitive.attributes[a].data;
                    else if (primitive.attributes[a].type == cgltf_attribute_type_weights)
                        weights = primitive.attributes[a].data;
                }
                const uint32_t count = model->scene.geometries[geometry].numVertices;
                const size_t first = model->jointWords.size() / 2;
                model->jointWords.resize((first + count) * 2, 0);
                model->weights.resize((first + count) * 4, 0.f);
                if (joints || weights)
                    model->hasJoints = true;
                if (joints)
                    for (uint32_t v = 0; v < count && v < joints->count; v++)
                    {
                        cgltf_uint j[4] = {};
                        cgltf_accessor_read_uint(joints, v, j, 4);
                        model->jointWords[(first + v) * 2] = (j[0] & 0xFFFF) | ((j[1] & 0xFFFF) << 16);
                        model->jointWords[(first + v) * 2 + 1] = (j[2] & 0xFFFF) | ((j[3] & 0xFFFF) << 16);
                    }
                if (weights && joints)
                    for (uint32_t v = 0; v < count && v < joints->count; v++)
                    {
                        float* w = &model->weights[(first + v) * 4];
                        if (weights->component_type == cgltf_component_type_r_8u || weights->component_type == cgltf_component_type_r_16u)
                        {
                            cgltf_uint raw[4] = {};
                            cgltf_accessor_read_uint(weights, v, raw, 4);
                            const float scale = weights->component_type == cgltf_component_type_r_8u ? 255.f : 65535.f;
                            for (int k = 0; k < 4; k++)
                                w[k] = float(raw[k]) / scale;
                        }
                        else
                            cgltf_accessor_read_float(weights, v, w, 4);
                    }
                mesh.totalVertices += count;
                geometry++;
            }
            model->meshes.push_back(mesh);
        }

        // The animations (GltfImporter: a sampler's interpolation from the channel of its index, as
        // GltfImporter reads it; channels of translations, rotations and scales).
        for (size_t a = 0; a < data->animations_count; a++)
        {
            const cgltf_animation& srcAnim = data->animations[a];
            std::map<const cgltf_animation_sampler*, int> samplers;
            for (size_t s = 0; s < srcAnim.samplers_count; s++)
            {
                const cgltf_animation_sampler& srcSampler = srcAnim.samplers[s];
                AnimationSampler sampler;
                switch (srcSampler.interpolation)
                {
                case cgltf_interpolation_type_linear:
                    sampler.mode = s < srcAnim.channels_count && srcAnim.channels[s].target_path == cgltf_animation_path_type_rotation
                        ? Interpolation::Slerp : Interpolation::Linear;
                    break;
                case cgltf_interpolation_type_step:
                    sampler.mode = Interpolation::Step;
                    break;
                case cgltf_interpolation_type_cubic_spline:
                    sampler.mode = Interpolation::HermiteSpline;
                    break;
                default:
                    break;
                }
                const cgltf_accessor* times = srcSampler.input;
                const cgltf_accessor* values = srcSampler.output;
                for (size_t k = 0; k < times->count; k++)
                {
                    Keyframe keyframe;
                    const bool timeRead = cgltf_accessor_read_float(times, k, &keyframe.time, 1);
                    bool valueRead;
                    if (srcSampler.interpolation == cgltf_interpolation_type_cubic_spline)
                    {
                        valueRead = cgltf_accessor_read_float(values, k * 3 + 0, &keyframe.inTangent.x, 4);
                        valueRead = cgltf_accessor_read_float(values, k * 3 + 1, &keyframe.value.x, 4);
                        valueRead = cgltf_accessor_read_float(values, k * 3 + 2, &keyframe.outTangent.x, 4);
                    }
                    else
                        valueRead = cgltf_accessor_read_float(values, k, &keyframe.value.x, 4);
                    if (timeRead && valueRead)
                        sampler.keyframes.push_back(keyframe);
                }
                if (!sampler.keyframes.empty())
                {
                    samplers[&srcSampler] = int(model->samplers.size());
                    model->samplers.push_back(std::move(sampler));
                }
            }
            ModelAnimation animation;
            for (size_t c = 0; c < srcAnim.channels_count; c++)
            {
                const cgltf_animation_channel& srcChannel = srcAnim.channels[c];
                if (!srcChannel.target_node)
                    continue;
                ModelAnimation::Channel channel;
                switch (srcChannel.target_path)
                {
                case cgltf_animation_path_type_translation: channel.attribute = Attribute_Translation; break;
                case cgltf_animation_path_type_rotation: channel.attribute = Attribute_Rotation; break;
                case cgltf_animation_path_type_scale: channel.attribute = Attribute_Scaling; break;
                default: continue;
                }
                auto found = samplers.find(srcChannel.sampler);
                if (found == samplers.end())
                    continue;
                channel.sampler = found->second;
                channel.gltfNode = size_t(srcChannel.target_node - data->nodes);
                animation.channels.push_back(channel);
                animation.duration = std::max(animation.duration, model->samplers[size_t(found->second)].EndTime());
            }
            model->animations.push_back(std::move(animation));
        }
        return model;
    }

    // Merges a model's static data into the scene's DonutScene (LoadScene's offsets moved past the
    // models before it).
    void MergeModel(DonutAnimatedScene& scene, Model& model)
    {
        DonutScene& merged = scene.merged;
        const DonutScene& source = model.scene;
        const uint32_t baseBytes = uint32_t(merged.vertices.size() * 4);
        merged.vertices.insert(merged.vertices.end(), source.vertices.begin(), source.vertices.end());
        for (int s = 0; s < VertexStream_Count; s++)
            model.streamBytes[s] = baseBytes + source.streamOffsets[s];
        if (model.hasJoints)
        {
            model.jointBytes = uint32_t(merged.vertices.size() * 4);
            merged.vertices.insert(merged.vertices.end(), model.jointWords.begin(), model.jointWords.end());
            model.weightBytes = uint32_t(merged.vertices.size() * 4);
            const size_t start = merged.vertices.size();
            merged.vertices.resize(start + model.weights.size());
            if (!model.weights.empty())
                memcpy(&merged.vertices[start], model.weights.data(), model.weights.size() * sizeof(float));
        }

        model.firstIndex = uint32_t(merged.indices.size());
        merged.indices.insert(merged.indices.end(), source.indices.begin(), source.indices.end());

        model.firstTexture = uint32_t(merged.textures.size());
        merged.textures.insert(merged.textures.end(), source.textures.begin(), source.textures.end());
        merged.textureSrgb.insert(merged.textureSrgb.end(), source.textureSrgb.begin(), source.textureSrgb.end());

        model.firstMaterial = uint32_t(merged.materials.size());
        auto moved = [&model](int texture) { return texture >= 0 ? texture + int(model.firstTexture) : texture; };
        for (size_t m = 0; m < source.materials.size(); m++)
        {
            MaterialConstants constants = source.materials[m];
            constants.baseOrDiffuseTextureIndex = moved(constants.baseOrDiffuseTextureIndex);
            constants.metalRoughOrSpecularTextureIndex = moved(constants.metalRoughOrSpecularTextureIndex);
            constants.normalTextureIndex = moved(constants.normalTextureIndex);
            constants.emissiveTextureIndex = moved(constants.emissiveTextureIndex);
            constants.occlusionTextureIndex = moved(constants.occlusionTextureIndex);
            constants.transmissionTextureIndex = moved(constants.transmissionTextureIndex);
            constants.opacityTextureIndex = moved(constants.opacityTextureIndex);
            merged.materials.push_back(constants);
            std::array<int, MaterialTexture_Count> textures = source.materialTextures[m];
            for (int& texture : textures)
                texture = moved(texture);
            merged.materialTextures.push_back(textures);
            merged.materialDoubleSided.push_back(source.materialDoubleSided[m]);
        }

        model.firstGeometry = uint32_t(merged.geometries.size());
        for (size_t g = 0; g < source.geometries.size(); g++)
        {
            GeometryData geometry = source.geometries[g];
            geometry.indexOffset += model.firstIndex * 4;
            geometry.positionOffset += baseBytes;
            geometry.texCoord1Offset += baseBytes;
            geometry.normalOffset += baseBytes;
            geometry.tangentOffset += baseBytes;
            geometry.materialIndex += model.firstMaterial;
            merged.geometries.push_back(geometry);
            merged.firstVertices.push_back(source.firstVertices[g]);
            scene.positionWords.push_back(model.streamBytes[VertexStream_Position] / 4 + source.firstVertices[g] * 3);
        }
    }

    int AddNode(DonutAnimatedScene& scene, int parent)
    {
        GraphNode node;
        node.parent = parent;
        scene.nodes.push_back(node);
        return int(scene.nodes.size()) - 1;
    }

    // A skinned instance of the model's mesh: Donut's SkinnedMeshInstance, its vertices in the skinned
    // vertex buffer (Scene::CreateMeshBuffers' ranges: positions, previous positions, normals, tangents,
    // texture coordinates), its geometries copied (Scene::UpdateGeometry: their vertices in buffer 2).
    void AddSkinnedInstance(DonutAnimatedScene& scene, Model& model, int modelIndex, int meshIndex, int node)
    {
        const ModelMesh& mesh = model.meshes[size_t(meshIndex)];
        SkinnedInstanceInfo skinned;
        skinned.instance = int(scene.instances.size());
        const uint32_t vertices = mesh.totalVertices;
        uint32_t offset = scene.skinnedVertexBytes;
        skinned.positionBytes = offset;
        offset += AlignTo16(vertices * 12);
        skinned.prevPositionBytes = offset;
        offset += AlignTo16(vertices * 12);
        skinned.normalBytes = offset;
        offset += AlignTo16(vertices * 4);
        skinned.tangentBytes = offset;
        offset += AlignTo16(vertices * 4);
        skinned.texCoordBytes = offset;
        offset += AlignTo16(vertices * 8);
        scene.skinnedVertexBytes = offset;

        MeshInstanceInfo instance;
        instance.node = node;
        instance.model = modelIndex;
        instance.mesh = meshIndex;
        instance.firstGeometry = uint32_t(scene.merged.geometries.size());
        instance.geometryCount = mesh.geometryCount;
        instance.skinned = int(scene.skinned.size());
        for (uint32_t g = 0; g < mesh.geometryCount; g++)
        {
            const uint32_t prototype = model.firstGeometry + mesh.firstGeometry + g;
            GeometryData geometry = scene.merged.geometries[prototype];
            const uint32_t vertex = scene.merged.firstVertices[prototype] - mesh.vertexOffset;
            geometry.vertexBufferIndex = 2;
            geometry.positionOffset = skinned.positionBytes + vertex * 12;
            geometry.prevPositionOffset = skinned.prevPositionBytes + vertex * 12;
            geometry.normalOffset = skinned.normalBytes + vertex * 4;
            geometry.tangentOffset = skinned.tangentBytes + vertex * 4;
            geometry.texCoord1Offset = skinned.texCoordBytes + vertex * 8;
            geometry.texCoord2Offset = ~0u;
            geometry.curveRadiusOffset = ~0u;
            scene.merged.geometries.push_back(geometry);
            scene.merged.firstVertices.push_back(vertex);
            scene.positionWords.push_back(0);
        }
        scene.instances.push_back(instance);
        scene.skinned.push_back(std::move(skinned));
    }

    // The node tree of a model under parent, as GltfImporter builds it and SceneGraph::Attach copies
    // it: the model's root (no transform), the glTF scene's nodes depth first; mesh instances numbered
    // as the scene graph registers them (depth first), then the model's animations. Its root node.
    int AddModel(DonutAnimatedScene& scene, int modelIndex, int parent)
    {
        Model& model = *scene.models[size_t(modelIndex)];
        const cgltf_data* data = model.data.get();
        const int root = AddNode(scene, parent);
        std::vector<int> nodeMap(data->nodes_count, -1);
        // The skinned instances and their glTF nodes (joints resolved once the tree is built).
        std::vector<std::pair<int, const cgltf_node*>> skinnedNodes;

        struct Item
        {
            const cgltf_node* node;
            int parent;
        };
        std::vector<Item> stack;
        const cgltf_scene* gltfScene = data->scene ? data->scene : data->scenes_count > 0 ? &data->scenes[0] : nullptr;
        if (gltfScene)
            for (size_t i = gltfScene->nodes_count; i-- > 0;)
                stack.push_back({ gltfScene->nodes[i], root });
        while (!stack.empty())
        {
            const Item item = stack.back();
            stack.pop_back();
            const cgltf_node& src = *item.node;
            const int index = AddNode(scene, item.parent);
            nodeMap[size_t(item.node - data->nodes)] = index;
            GraphNode& node = scene.nodes[size_t(index)];
            if (src.has_matrix)
            {
                const affine3 matrix = affine3(&src.matrix[0], &src.matrix[4], &src.matrix[8], &src.matrix[12]);
                decomposeAffine(daffine3(matrix), &node.translation, &node.rotation, &node.scaling);
                node.hasLocalTransform = true;
            }
            else
            {
                if (src.has_scale)
                    node.scaling = double3(float3(src.scale));
                if (src.has_rotation)
                    node.rotation = dquat(quat::fromXYZW(src.rotation));
                if (src.has_translation)
                    node.translation = double3(float3(src.translation));
                node.hasLocalTransform = src.has_scale || src.has_rotation || src.has_translation;
            }
            if (src.mesh)
            {
                const int mesh = int(src.mesh - data->meshes);
                if (src.skin)
                {
                    skinnedNodes.push_back({ int(scene.skinned.size()), &src });
                    AddSkinnedInstance(scene, model, modelIndex, mesh, index);
                }
                else
                {
                    MeshInstanceInfo instance;
                    instance.node = index;
                    instance.model = modelIndex;
                    instance.mesh = mesh;
                    instance.firstGeometry = model.firstGeometry + model.meshes[size_t(mesh)].firstGeometry;
                    instance.geometryCount = model.meshes[size_t(mesh)].geometryCount;
                    scene.instances.push_back(instance);
                }
            }
            for (size_t i = src.children_count; i-- > 0;)
                stack.push_back({ src.children[i], index });
        }

        for (const auto& [skinnedIndex, src] : skinnedNodes)
        {
            SkinnedInstanceInfo& skinned = scene.skinned[size_t(skinnedIndex)];
            const cgltf_skin& skin = *src->skin;
            for (size_t j = 0; j < skin.joints_count; j++)
            {
                float4x4 inverseBind = float4x4::identity();
                if (skin.inverse_bind_matrices)
                    cgltf_accessor_read_float(skin.inverse_bind_matrices, j, inverseBind.m_data, 16);
                skinned.inverseBindMatrices.push_back(inverseBind);
                skinned.jointNodes.push_back(nodeMap[size_t(skin.joints[j] - data->nodes)]);
            }
            skinned.jointMatrices.resize(skin.joints_count, float4x4::identity());
        }

        for (const ModelAnimation& source : model.animations)
        {
            AnimationInstance animation;
            animation.duration = source.duration;
            for (const ModelAnimation::Channel& channel : source.channels)
                animation.channels.push_back({ &model.samplers[size_t(channel.sampler)], nodeMap[channel.gltfNode], channel.attribute });
            scene.animations.push_back(std::move(animation));
        }
        return root;
    }

    // Scene::LoadSceneGraph: the file's nodes (a model instanced, or a node of its own) under parent,
    // their names ignored, their translations, rotations (or Euler angles) and scalings set.
    void AddGraphNodes(DonutAnimatedScene& scene, const JsonValue& nodeList, int parent)
    {
        for (const JsonValue& src : nodeList.items)
        {
            if (src.type != JsonValue::Object)
                continue;
            if (src.Find("parent"))
                printf("WARNING: scene nodes' custom parents aren't supported, ignored\n");
            int dst = -1;
            const JsonValue* model = src.Find("model");
            if (model && model->type == JsonValue::Number)
            {
                const int modelIndex = int(model->number);
                if (modelIndex < 0 || modelIndex >= int(scene.models.size()) || !scene.models[size_t(modelIndex)])
                    continue;
                dst = AddModel(scene, modelIndex, parent);
                // A model instanced again is SceneGraph::Attach's copy of the first instance, its
                // root's transform included (the file's then set over it).
                int& firstRoot = scene.models[size_t(modelIndex)]->firstRoot;
                if (firstRoot >= 0)
                {
                    const GraphNode source = scene.nodes[size_t(firstRoot)];
                    GraphNode& copy = scene.nodes[size_t(dst)];
                    copy.hasLocalTransform = source.hasLocalTransform;
                    copy.translation = source.translation;
                    copy.rotation = source.rotation;
                    copy.scaling = source.scaling;
                }
                else
                    firstRoot = dst;
            }
            else
                dst = AddNode(scene, parent);

            GraphNode& node = scene.nodes[size_t(dst)];
            if (const JsonValue* translation = src.Find("translation"))
            {
                node.translation = ReadDouble3(*translation, double3::zero());
                node.hasLocalTransform = true;
            }
            if (const JsonValue* rotation = src.Find("rotation"))
            {
                node.rotation = dquat::fromXYZW(ReadDouble4(*rotation, double4(0.0, 0.0, 0.0, 1.0)));
                node.hasLocalTransform = true;
            }
            else if (const JsonValue* euler = src.Find("euler"))
            {
                node.rotation = rotationQuat(ReadDouble3(*euler, double3::zero()));
                node.hasLocalTransform = true;
            }
            if (const JsonValue* scaling = src.Find("scaling"))
            {
                node.scaling = ReadDouble3(*scaling, double3(1.0));
                node.hasLocalTransform = true;
            }
            if (const JsonValue* children = src.Find("children"))
                AddGraphNodes(scene, *children, dst);
            if (src.Find("type"))
                printf("WARNING: scene node leaves (lights, cameras...) aren't supported, ignored\n");
        }
    }

    // A scene file (or a glTF file: one model), path relative to the library's folder; false (after
    // printing why) on failure.
    bool LoadAnimatedScene(const char* path, DonutAnimatedScene& scene)
    {
        const std::string relative = path;
        const size_t dot = relative.find_last_of('.');
        const std::string extension = dot == std::string::npos ? std::string() : relative.substr(dot);
        if (extension == ".gltf" || extension == ".glb")
        {
            auto model = LoadModel(relative);
            if (!model)
                return false;
            scene.models.push_back(std::move(model));
            MergeModel(scene, *scene.models[0]);
            AddModel(scene, 0, -1);
            return true;
        }

        const std::string fileName = NriLibraryPath(path);
        FILE* file = fopen(fileName.c_str(), "rb");
        if (!file)
        {
            printf("ERROR: cannot open %s\n", fileName.c_str());
            return false;
        }
        std::string text;
        char buffer[4096];
        size_t read;
        while ((read = fread(buffer, 1, sizeof(buffer), file)) > 0)
            text.append(buffer, read);
        fclose(file);
        JsonParser parser;
        parser.p = text.c_str();
        parser.end = parser.p + text.size();
        JsonValue document;
        if (!parser.Parse(document) || document.type != JsonValue::Object)
        {
            printf("ERROR: %s isn't a scene file\n", fileName.c_str());
            return false;
        }

        // The models, relative to the scene file's folder; a model that can't be loaded isn't
        // instanced (as Donut skips it).
        const size_t slash = relative.find_last_of("/\\");
        const std::string folder = slash == std::string::npos ? std::string() : relative.substr(0, slash + 1);
        if (const JsonValue* models = document.Find("models"))
            for (const JsonValue& model : models->items)
            {
                scene.models.push_back(model.type == JsonValue::String ? LoadModel(folder + model.string) : nullptr);
                if (scene.models.back())
                    MergeModel(scene, *scene.models.back());
            }

        const int root = AddNode(scene, -1);
        if (const JsonValue* graph = document.Find("graph"))
            AddGraphNodes(scene, *graph, root);
        if (document.Find("animations"))
            printf("WARNING: scene files' own animations aren't supported, ignored\n");
        return true;
    }

    // SceneGraph::Refresh's transforms (nodes come after their parents), Scene::UpdateInstance's
    // InstanceData, Scene::UpdateSkinnedMeshes' joint matrices.
    void RefreshAnimatedScene(DonutAnimatedScene& scene)
    {
        for (GraphNode& node : scene.nodes)
        {
            daffine3 local = daffine3::identity();
            if (node.hasLocalTransform)
            {
                local = scaling(node.scaling);
                local *= node.rotation.toAffine();
                local *= translation(node.translation);
            }
            if (node.parent >= 0)
                node.global = node.hasLocalTransform ? local * scene.nodes[size_t(node.parent)].global : scene.nodes[size_t(node.parent)].global;
            else
                node.global = local;
            node.globalFloat = affine3(node.global);
        }

        std::vector<InstanceData>& instances = scene.merged.instances;
        const bool first = instances.size() != scene.instances.size();
        instances.resize(scene.instances.size());
        uint32_t firstGeometryInstance = 0;
        for (size_t i = 0; i < scene.instances.size(); i++)
        {
            const MeshInstanceInfo& info = scene.instances[i];
            InstanceData& instance = instances[i];
            const float3x4 previous = instance.transform;
            affineToColumnMajor(scene.nodes[size_t(info.node)].globalFloat, instance.transform);
            instance.prevTransform = first ? instance.transform : previous;
            instance.flags = 0;
            instance.firstGeometryInstanceIndex = firstGeometryInstance;
            instance.numGeometries = info.geometryCount;
            instance.firstGeometryIndex = info.geometryCount > 0 ? info.firstGeometry : ~0u;
            firstGeometryInstance += info.geometryCount;
        }

        for (SkinnedInstanceInfo& skinned : scene.skinned)
        {
            const daffine3 worldToRoot = inverse(scene.nodes[size_t(scene.instances[size_t(skinned.instance)].node)].global);
            for (size_t j = 0; j < skinned.jointNodes.size(); j++)
            {
                float4x4 jointMatrix = affineToHomogeneous(affine3(scene.nodes[size_t(skinned.jointNodes[j])].global * worldToRoot));
                jointMatrix = skinned.inverseBindMatrices[j] * jointMatrix;
                skinned.jointMatrices[j] = jointMatrix;
            }
        }
        scene.refreshed = true;
    }

    // The acceleration structures of an animated scene (Donut_CreateAnimatedSceneAccelStructs'): a
    // static mesh's BLAS (shared by its instances), a skinned instance's, each instance's, the TLAS.
    struct DonutAnimatedSceneAccelStructs
    {
        std::vector<void*> staticBlases;
        std::vector<void*> skinnedBlases;
        std::vector<void*> instanceBlases;
        void* tlas = nullptr;
    };

    bool IsOpaque(const DonutScene& merged, const GeometryData& geometry)
    {
        return merged.materials[geometry.materialIndex].domain != MaterialDomain_AlphaTested;
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
    // InstanceData as a ByteAddressBuffer (D3D11's shaders read them so); 7 the vertices and 8 the
    // indices without a structure stride, for typed views (Nri_CreateTypedBufferView: Vulkan's texel
    // buffers); null on failure.
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
        case 7: return Nri_CreateUploadedStructuredBuffer(device, queue, scene->vertices.data(), int(scene->vertices.size() * 4), 0);
        case 8: return Nri_CreateUploadedStructuredBuffer(device, queue, scene->indices.data(), int(scene->indices.size() * 4), 0);
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
    // The meshes' geometries (the GeometryData), in global geometry order.
    NRI_INTEROP_API int Nri_GetDonutSceneGeometryCount(DonutScene* scene)
    {
        return int(scene->geometries.size());
    }

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
    NRI_INTEROP_API DonutSceneAccelStructs* Nri_BuildDonutSceneAccelStructsWithHitGroupStride(void* device, void* queue, DonutScene* scene,
        int hitGroupStride);

    NRI_INTEROP_API DonutSceneAccelStructs* Nri_BuildDonutSceneAccelStructs(void* device, void* queue, DonutScene* scene)
    {
        return Nri_BuildDonutSceneAccelStructsWithHitGroupStride(device, queue, scene, 0);
    }

    // As Nri_BuildDonutSceneAccelStructs, for shader tables with hitGroupStride entries per geometry in
    // global geometry order, as Donut_BuildSceneAccelStructsWithHitGroupStride: an instance's hit groups
    // start at its mesh's first geometry index times hitGroupStride. With a stride, the instance IDs are
    // that first geometry index (InstanceID() + GeometryIndex(): the hit geometry's GeometryData).
    NRI_INTEROP_API DonutSceneAccelStructs* Nri_BuildDonutSceneAccelStructsWithHitGroupStride(void* device, void* queue, DonutScene* scene,
        int hitGroupStride)
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
            const int firstGeometry = hitGroupStride ? int(instance.firstGeometryIndex) : 0;
            Nri_TopLevelASAddInstance(accelStructs->tlas, meshBlases[instance.firstGeometryIndex], transform, firstGeometry, 1,
                firstGeometry * hitGroupStride, 0);
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

namespace
{
    // The first node named name (depth first from the node), its global translation as Donut's
    // SceneGraphNode::GetLocalToWorldTransformFloat has it; false if there's none.
    bool FindNodeTranslation(const cgltf_node& node, const daffine3& parentToWorld, const char* name, float* dst)
    {
        const daffine3 localToWorld = LocalTransform(node) * parentToWorld;
        if (node.name && strcmp(node.name, name) == 0)
        {
            const float3 translationValue = affine3(localToWorld).m_translation;
            memcpy(dst, &translationValue, sizeof(translationValue));
            return true;
        }
        for (size_t i = 0; i < node.children_count; i++)
            if (FindNodeTranslation(*node.children[i], localToWorld, name, dst))
                return true;
        return false;
    }
}

extern "C"
{
    // A dynamic mesh (Donut_CreateDynamicMesh, then Donut_AttachDynamicMesh) added to the scene: one
    // geometry of maxVertices float3 positions followed by maxVertices float2 texture coordinates in
    // bindless buffer vertexBufferIndex and maxIndices 32-bit indices in bindless buffer
    // indexBufferIndex, its material Donut's default Material in MaterialDomain::AlphaBlended, as an
    // instance under the scene's root (identity transform), after the scene's instances, geometries and
    // materials (as Donut's Scene::Refresh numbers them once it's attached). Create the scene's buffers
    // 2 to 4 after this. Returns the instance's index.
    NRI_INTEROP_API int Nri_AddDonutSceneDynamicMesh(DonutScene* scene, int maxVertices, int maxIndices, int vertexBufferIndex,
        int indexBufferIndex)
    {
        std::array<int, MaterialTexture_Count> none;
        none.fill(-1);
        const uint32_t materialIndex = uint32_t(scene->materials.size());
        MaterialConstants material = ImportMaterial(nullptr, none);
        // Material::FillConstantBuffer for AlphaBlended: the opacity as it is (1), the alpha cutoff -1
        // (its switch falls through from the 0 it sets to -1), and the material's ID.
        material.domain = MaterialDomain_AlphaBlended;
        material.alphaCutoff = -1.f;
        material.materialID = int(materialIndex);
        scene->materials.push_back(material);
        scene->materialTextures.push_back(none);
        scene->materialDoubleSided.push_back(false);

        // Scene::UpdateGeometry: the attributes the buffer group has (positions, texture coordinates),
        // ~0 for the others; numIndices and numVertices as the mesh is created (full size).
        GeometryData geometry = {};
        geometry.numIndices = uint32_t(maxIndices);
        geometry.numVertices = uint32_t(maxVertices);
        geometry.indexBufferIndex = indexBufferIndex;
        geometry.indexOffset = 0;
        geometry.vertexBufferIndex = vertexBufferIndex;
        geometry.positionOffset = 0;
        geometry.prevPositionOffset = ~0u;
        geometry.texCoord1Offset = uint32_t(size_t(maxVertices) * sizeof(float3));
        geometry.texCoord2Offset = ~0u;
        geometry.normalOffset = ~0u;
        geometry.tangentOffset = ~0u;
        geometry.curveRadiusOffset = ~0u;
        geometry.materialIndex = materialIndex;
        const uint32_t geometryIndex = uint32_t(scene->geometries.size());
        scene->geometries.push_back(geometry);
        scene->firstVertices.push_back(0);
        scene->meshBounds.push_back(box3::empty());

        InstanceData instance = {};
        affineToColumnMajor(affine3::identity(), instance.transform);
        affineToColumnMajor(affine3::identity(), instance.prevTransform);
        instance.numGeometries = 1;
        instance.firstGeometryIndex = geometryIndex;
        uint32_t firstGeometryInstance = 0;
        for (const InstanceData& other : scene->instances)
            firstGeometryInstance += other.numGeometries;
        instance.firstGeometryInstanceIndex = firstGeometryInstance;
        scene->instances.push_back(instance);
        return int(scene->instances.size() - 1);
    }

    // A material's base or diffuse texture (Donut_SetDynamicMeshTexture's): its bindless texture index
    // (-1: none), the flag MaterialConstants have for it. Create the scene's buffer 4 after this.
    NRI_INTEROP_API void Nri_SetDonutSceneMaterialBaseTexture(DonutScene* scene, int material, int textureIndex)
    {
        MaterialConstants& constants = scene->materials[size_t(material)];
        constants.baseOrDiffuseTextureIndex = textureIndex;
        if (textureIndex >= 0)
            constants.flags |= MaterialFlags_UseBaseOrDiffuseTexture;
        else
            constants.flags &= ~MaterialFlags_UseBaseOrDiffuseTexture;
        scene->materialTextures[size_t(material)][MaterialTexture_BaseOrDiffuse] = textureIndex;
    }

    // The BLAS Nri_BuildDonutSceneAccelStructs built for an instance's mesh (the instances of a mesh
    // share it), for TLASes the example builds itself; null for an instance it didn't build one for
    // (no geometries, or added after the structures were built).
    NRI_INTEROP_API void* Nri_GetDonutSceneInstanceBlas(DonutScene* scene, DonutSceneAccelStructs* accelStructs, int instance)
    {
        // The BLASes in the order Nri_BuildDonutSceneAccelStructsWithHitGroupStride made them: a mesh's
        // at its first instance.
        std::map<uint32_t, size_t> meshBlases;
        for (size_t i = 0; i < scene->instances.size(); i++)
        {
            const InstanceData& data = scene->instances[i];
            if (data.numGeometries == 0)
                continue;
            if (!meshBlases.count(data.firstGeometryIndex))
            {
                const size_t next = meshBlases.size();
                meshBlases[data.firstGeometryIndex] = next;
            }
            if (int(i) == instance)
            {
                const size_t blas = meshBlases[data.firstGeometryIndex];
                return blas < accelStructs->blases.size() ? accelStructs->blases[blas] : nullptr;
            }
        }
        return nullptr;
    }

    // An instance's transform (its InstanceData's: affineToColumnMajor's float3x4, 12 floats into dst),
    // as Donut_AddSceneTopLevelASInstances gives the TLAS.
    NRI_INTEROP_API void Nri_GetDonutSceneInstanceTransform(DonutScene* scene, int instance, float* dst)
    {
        memcpy(dst, &scene->instances[size_t(instance)].transform, sizeof(float) * 12);
    }

    // The world-space position of a glTF file's node (path relative to the library's folder; nodePath
    // like "/Emitter": its last name), as Donut_GetSceneNodePosition gives it: 3 floats into dst. 0 if
    // the file can't be read or has no such node.
    NRI_INTEROP_API int Nri_GetDonutSceneNodePosition(const char* path, const char* nodePath, float* dst)
    {
        const std::string fileName = NriLibraryPath(path);
        cgltf_options options{};
        cgltf_data* data = nullptr;
        if (cgltf_parse_file(&options, fileName.c_str(), &data) != cgltf_result_success)
        {
            if (data)
                cgltf_free(data);
            return 0;
        }
        std::unique_ptr<cgltf_data, void (*)(cgltf_data*)> owner(data, cgltf_free);
        const char* slash = strrchr(nodePath, '/');
        const char* name = slash ? slash + 1 : nodePath;
        const cgltf_scene* root = data->scene ? data->scene : data->scenes_count > 0 ? &data->scenes[0] : nullptr;
        if (root)
            for (size_t i = 0; i < root->nodes_count; i++)
                if (FindNodeTranslation(*root->nodes[i], daffine3::identity(), name, dst))
                    return 1;
        return 0;
    }
}

extern "C"
{
    NRI_INTEROP_API void Nri_DestroyDonutAnimatedSceneAccelStructs(DonutAnimatedSceneAccelStructs* accelStructs);

    // A scene file (Donut's .scene.json: models instanced by a node graph, as Scene::Load loads it) or
    // a glTF file, path relative to the library's folder, with its skins and animations; null (after
    // printing why) on failure. Destroyed with Nri_DestroyDonutAnimatedScene. Its transforms are the
    // file's until Nri_RefreshDonutAnimatedScene.
    NRI_INTEROP_API DonutAnimatedScene* Nri_LoadDonutAnimatedScene(const char* path)
    {
        auto scene = std::make_unique<DonutAnimatedScene>();
        if (!LoadAnimatedScene(path, *scene))
            return nullptr;
        RefreshAnimatedScene(*scene);
        return scene.release();
    }

    NRI_INTEROP_API void Nri_DestroyDonutAnimatedScene(DonutAnimatedScene* scene)
    {
        delete scene;
    }

    // Its static data as a Donut scene (an NriDonutSceneHandle, valid as long as the animated scene):
    // for Nri_CreateDonutSceneBuffer (0 the vertices and the joint indices and weights, 1 the indices,
    // 3 the GeometryData, skinned copies included, 4 the MaterialConstants) and its textures; its
    // InstanceData change with the animations (Nri_WriteDonutAnimatedSceneInstances).
    NRI_INTEROP_API DonutScene* Nri_GetDonutAnimatedSceneScene(DonutAnimatedScene* scene)
    {
        return &scene->merged;
    }

    // The animations (SceneGraph::GetAnimations' order: the scene graph's), each's duration in seconds.
    NRI_INTEROP_API int Nri_GetDonutAnimationCount(DonutAnimatedScene* scene)
    {
        return int(scene->animations.size());
    }

    NRI_INTEROP_API double Nri_GetDonutAnimationDuration(DonutAnimatedScene* scene, int index)
    {
        return double(scene->animations[size_t(index)].duration);
    }

    // Poses the animation's nodes at time seconds into it (SceneGraphAnimation::Apply(float(time))).
    NRI_INTEROP_API void Nri_ApplyDonutAnimation(DonutAnimatedScene* scene, int index, double time)
    {
        for (const AnimationInstance::Channel& channel : scene->animations[size_t(index)].channels)
        {
            float4 value;
            if (channel.node < 0 || !channel.sampler->Evaluate(float(time), value))
                continue;
            GraphNode& node = scene->nodes[size_t(channel.node)];
            switch (channel.attribute)
            {
            case Attribute_Scaling:
                node.scaling = double3(value.xyz());
                break;
            case Attribute_Rotation: {
                dquat rotation = dquat::fromXYZW(double4(value));
                const double len = length(rotation);
                if (len == 0.0)
                    continue;
                rotation /= len;
                node.rotation = rotation;
                break;
            }
            case Attribute_Translation:
                node.translation = double3(value.xyz());
                break;
            }
            node.hasLocalTransform = true;
        }
    }

    // After animations: the nodes' transforms, the instances' InstanceData, the skinned instances'
    // joint matrices (Scene::Refresh's).
    NRI_INTEROP_API void Nri_RefreshDonutAnimatedScene(DonutAnimatedScene* scene)
    {
        RefreshAnimatedScene(*scene);
    }

    // The InstanceData (bindless.h's) of the instances, in instance order: their size in bytes, and
    // written into buffer (a host buffer) at offset.
    NRI_INTEROP_API int Nri_GetDonutAnimatedSceneInstanceDataSize(DonutAnimatedScene* scene)
    {
        return int(scene->merged.instances.size() * sizeof(InstanceData));
    }

    NRI_INTEROP_API int Nri_GetDonutAnimatedSceneInstanceDataStride(DonutAnimatedScene*)
    {
        return int(sizeof(InstanceData));
    }

    NRI_INTEROP_API void Nri_WriteDonutAnimatedSceneInstances(DonutAnimatedScene* scene, void* buffer, int offset)
    {
        Nri_WriteBuffer(buffer, offset, scene->merged.instances.data(), int(scene->merged.instances.size() * sizeof(InstanceData)));
    }

    // The skinned instances (SceneGraph::GetSkinnedMeshInstances' order), each's joint count, its joint
    // matrices (float4x4 each, the skinning shader's t1) written into buffer (a host buffer) at offset.
    NRI_INTEROP_API int Nri_GetDonutSkinnedInstanceCount(DonutAnimatedScene* scene)
    {
        return int(scene->skinned.size());
    }

    NRI_INTEROP_API int Nri_GetDonutSkinnedJointCount(DonutAnimatedScene* scene, int skinned)
    {
        return int(scene->skinned[size_t(skinned)].jointMatrices.size());
    }

    // The skinned instance's vertex count (its prototype mesh's: SkinningConstants::numVertices).
    NRI_INTEROP_API int Nri_GetDonutSkinnedVertexCount(DonutAnimatedScene* scene, int skinned)
    {
        const MeshInstanceInfo& instance = scene->instances[size_t(scene->skinned[size_t(skinned)].instance)];
        return int(scene->models[size_t(instance.model)]->meshes[size_t(instance.mesh)].totalVertices);
    }

    NRI_INTEROP_API void Nri_WriteDonutSkinnedJoints(DonutAnimatedScene* scene, int skinned, void* buffer, int offset)
    {
        const std::vector<float4x4>& joints = scene->skinned[size_t(skinned)].jointMatrices;
        Nri_WriteBuffer(buffer, offset, joints.data(), int(joints.size() * sizeof(float4x4)));
    }

    // The skinned instance's SkinningConstants (skinning_cb.h: 15 uints) into dst, as
    // Scene::UpdateSkinnedMeshes sets them: its prototype mesh's vertices in bindless buffer 0 (normals,
    // tangents and first texture coordinates: GltfImporter's buffers always have them), its own in the
    // skinned vertex buffer; SkinningFlag_FirstFrame the first time only. Dispatch numVertices / 256
    // groups (rounded up).
    NRI_INTEROP_API void Nri_GetDonutSkinningConstants(DonutAnimatedScene* scene, int skinnedIndex, uint32_t* dst)
    {
        SkinnedInstanceInfo& skinned = scene->skinned[size_t(skinnedIndex)];
        const MeshInstanceInfo& instance = scene->instances[size_t(skinned.instance)];
        const Model& model = *scene->models[size_t(instance.model)];
        const ModelMesh& mesh = model.meshes[size_t(instance.mesh)];
        const uint32_t vertexOffset = mesh.vertexOffset;
        // SkinningFlag_Normals | _Tangents | _TexCoord1, and _FirstFrame.
        uint32_t flags = 0x02 | 0x04 | 0x08;
        if (!skinned.initialized)
            flags |= 0x01;
        skinned.initialized = true;
        const uint32_t constants[15] = {
            mesh.totalVertices,
            flags,
            model.streamBytes[VertexStream_Position] + vertexOffset * 12,
            model.streamBytes[VertexStream_Normal] + vertexOffset * 4,
            model.streamBytes[VertexStream_Tangent] + vertexOffset * 4,
            model.streamBytes[VertexStream_TexCoord] + vertexOffset * 8,
            vertexOffset * 8,
            model.jointBytes + vertexOffset * 8,
            model.weightBytes + vertexOffset * 16,
            skinned.positionBytes,
            skinned.prevPositionBytes,
            skinned.normalBytes,
            skinned.tangentBytes,
            skinned.texCoordBytes,
            0,
        };
        memcpy(dst, constants, sizeof(constants));
    }

    // The skinned vertex buffer's size in bytes (all the skinned instances' vertices, bindless buffer
    // 2: Nri_CreateAccelerationStructureInputStorageBuffer, stride 4); 0 without skinned instances.
    NRI_INTEROP_API int Nri_GetDonutSkinnedVertexBufferSize(DonutAnimatedScene* scene)
    {
        return int(scene->skinnedVertexBytes);
    }

    // As Donut_CreateAnimatedSceneAccelStructs: a BLAS per static mesh (built on the queue, which this
    // waits for: PreferFastTrace | AllowCompaction, alpha-tested geometries non-opaque), one per skinned
    // instance (built by Nri_CmdBuildDonutAnimatedSceneAccelStructs), a TLAS of the instances whose
    // instances go to one of bufferNum buffers a frame (the frames in flight); null on failure.
    NRI_INTEROP_API DonutAnimatedSceneAccelStructs* Nri_CreateDonutAnimatedSceneAccelStructs(void* device, void* queue,
        DonutAnimatedScene* scene, int bufferNum)
    {
        auto* accelStructs = new DonutAnimatedSceneAccelStructs();
        const DonutScene& merged = scene->merged;
        std::map<std::pair<int, int>, void*> meshBlases;
        for (const MeshInstanceInfo& instance : scene->instances)
        {
            void* accelerationStructure = nullptr;
            if (instance.skinned >= 0)
            {
                const SkinnedInstanceInfo& skinned = scene->skinned[size_t(instance.skinned)];
                void* blas = Nri_CreateBufferBlas(BLAS_PREFER_FAST_TRACE);
                for (uint32_t g = instance.firstGeometry; g < instance.firstGeometry + instance.geometryCount; g++)
                {
                    const GeometryData& geometry = merged.geometries[g];
                    Nri_BufferBlasAddTriangles(blas, int(skinned.positionBytes + merged.firstVertices[g] * 12), int(geometry.numVertices),
                        merged.indices.data() + geometry.indexOffset / 4, int(geometry.numIndices), IsOpaque(merged, geometry) ? 1 : 0);
                }
                accelStructs->skinnedBlases.push_back(blas);
                if (!Nri_BufferBlasCreate(device, blas))
                {
                    Nri_DestroyDonutAnimatedSceneAccelStructs(accelStructs);
                    return nullptr;
                }
                accelerationStructure = Nri_GetBufferBlasAccelerationStructure(blas);
            }
            else
            {
                const std::pair<int, int> key(instance.model, instance.mesh);
                auto found = meshBlases.find(key);
                if (found == meshBlases.end())
                {
                    void* desc = Nri_CreateBlasDesc();
                    const float* vertices = (const float*)merged.vertices.data();
                    for (uint32_t g = instance.firstGeometry; g < instance.firstGeometry + instance.geometryCount; g++)
                    {
                        const GeometryData& geometry = merged.geometries[g];
                        Nri_BlasDescAddTriangles(desc, vertices + scene->positionWords[g], int(geometry.numVertices),
                            merged.indices.data() + geometry.indexOffset / 4, int(geometry.numIndices));
                        Nri_BlasDescSetOpaque(desc, IsOpaque(merged, geometry) ? 1 : 0);
                    }
                    void* blas = Nri_BuildBlasFromDesc(device, queue, desc, BLAS_PREFER_FAST_TRACE | BLAS_ALLOW_COMPACTION);
                    Nri_DestroyBlasDesc(desc);
                    if (!blas)
                    {
                        Nri_DestroyDonutAnimatedSceneAccelStructs(accelStructs);
                        return nullptr;
                    }
                    accelStructs->staticBlases.push_back(blas);
                    found = meshBlases.emplace(key, blas).first;
                }
                accelerationStructure = found->second;
            }
            accelStructs->instanceBlases.push_back(accelerationStructure);
        }
        accelStructs->tlas = Nri_CreateTopLevelAS(device, int(scene->instances.size()), 0, bufferNum);
        if (!accelStructs->tlas)
        {
            Nri_DestroyDonutAnimatedSceneAccelStructs(accelStructs);
            return nullptr;
        }
        return accelStructs;
    }

    // The TLAS (an NriTopLevelASHandle), valid as long as the structures.
    NRI_INTEROP_API void* Nri_GetDonutAnimatedSceneTopLevelAS(DonutAnimatedSceneAccelStructs* accelStructs)
    {
        return accelStructs->tlas;
    }

    // As Donut_UpdateSceneAccelStructs, into the command buffer: with rebuildSkinned, the skinned
    // instances' BLASes built from skinnedVertexBuffer (skinned this frame, in NriBufferState
    // AccelerationStructureInput); the TLAS built from the instances' current transforms (instance IDs
    // the instance indices, mask 1, hit group offset 0), its instances in buffer bufferIndex.
    NRI_INTEROP_API void Nri_CmdBuildDonutAnimatedSceneAccelStructs(void* commandBuffer, DonutAnimatedSceneAccelStructs* accelStructs,
        DonutAnimatedScene* scene, void* skinnedVertexBuffer, int bufferIndex, int rebuildSkinned)
    {
        if (rebuildSkinned && skinnedVertexBuffer)
            for (void* blas : accelStructs->skinnedBlases)
                Nri_CmdBuildBufferBlas(commandBuffer, blas, skinnedVertexBuffer);
        Nri_TopLevelASClearInstances(accelStructs->tlas);
        for (size_t i = 0; i < scene->merged.instances.size(); i++)
        {
            // affineToColumnMajor's float3x4, as NVRHI's AffineTransform takes it.
            float transform[12];
            memcpy(transform, &scene->merged.instances[i].transform, sizeof(transform));
            Nri_TopLevelASAddInstance(accelStructs->tlas, accelStructs->instanceBlases[i], transform, int(i), 1, 0, 0);
        }
        Nri_CmdBuildTopLevelAS(commandBuffer, accelStructs->tlas, bufferIndex, 0);
    }

    NRI_INTEROP_API void Nri_DestroyDonutAnimatedSceneAccelStructs(DonutAnimatedSceneAccelStructs* accelStructs)
    {
        if (accelStructs->tlas)
            Nri_DestroyTopLevelAS(accelStructs->tlas);
        for (void* blas : accelStructs->skinnedBlases)
            Nri_DestroyBufferBlas(blas);
        for (void* blas : accelStructs->staticBlases)
            Nri_DestroyAccelerationStructure(blas);
        delete accelStructs;
    }
}

// Wavefront OBJ models for TypeScript (the examples that list it link it; see CMakeLists.txt): the
// loader of DirectX-Graphics-Samples' D3D12RaytracingSakuraForestSER (its ObjModelLoader), line for
// line: objects by their `o` names (a name met again continues the object), positions, normals and
// texture coordinates, and triangles; then an object's triangles unindexed, three vertices each, as
// its GetObjectVerticesAndIndices hands them out. Files are parsed from memory (e.g. a
// Donut_LoadBinaryFile's data), their `\r`s dropped as the sample's text-mode ifstream does.
// Functions of no Donut object, so donut.ts doesn't wrap them and other examples don't link them.
//
// Copyright (c) Microsoft. All rights reserved.
// This code is licensed under the MIT License (MIT).

#include <cstdint>
#include <cstring>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

namespace
{
    struct Float2 { float x, y; };
    struct Float3 { float x, y, z; };

    // RaytracingHlslCompat.h's Vertex: position, normal, uv (a float3: z stays 0).
    struct Vertex
    {
        Float3 position;
        Float3 normal;
        Float3 uv;
    };

    class Object
    {
    public:
        explicit Object(std::string const& name)
            : m_name(name)
        {
        }

        std::string const& GetName() const { return m_name; }

        struct FaceElementIndices
        {
            unsigned int Values[3];
        };

        struct Face
        {
            FaceElementIndices VertexIndices;
            bool UseNormals;
            bool UseTexCoords;
            FaceElementIndices NormalIndices;
            FaceElementIndices TexCoordIndices;
        };

        void AddObjFace(const FaceElementIndices& vertexIndices,
            const std::optional<FaceElementIndices>& normalIndices = std::nullopt,
            const std::optional<FaceElementIndices>& texCoordIndices = std::nullopt)
        {
            Face face;
            face.VertexIndices = vertexIndices;
            if (normalIndices)
            {
                face.UseNormals = true;
                face.NormalIndices = *normalIndices;
            }
            else
            {
                face.UseNormals = false;
            }
            if (texCoordIndices)
            {
                face.UseTexCoords = true;
                face.TexCoordIndices = *texCoordIndices;
            }
            else
            {
                face.UseTexCoords = false;
            }
            m_faces.push_back(face);
        }

        std::vector<Float3> m_vertices;
        std::vector<Float3> m_normals;
        std::vector<Float2> m_texCoords;
        std::vector<Face> m_faces;

    private:
        std::string m_name;
    };

    bool StartsWith(std::string const& line, const char* prefix)
    {
        return line.rfind(prefix, 0) == 0;
    }
}

// The loader's objects, and the last mesh Donut_BuildObjModelMesh made.
struct ObjModel
{
    std::vector<Object> objects;
    std::vector<Vertex> vertices;
    std::vector<uint32_t> indices;

    Object* GetObject(std::string const& name)
    {
        for (auto& obj : objects)
        {
            if (obj.GetName() == name)
                return &obj;
        }
        return nullptr;
    }

    Object* FindOrCreateObject(std::string const& name)
    {
        if (auto* obj = GetObject(name))
            return obj;
        objects.push_back(Object(name));
        return &objects.back();
    }

    // ObjModelLoader::Load.
    void Load(std::istream& openedFile)
    {
        std::string line;
        Object* currentObject = nullptr;
        while (std::getline(openedFile, line))
        {
            if (!line.empty() && line.back() == '\r')
                line.pop_back();
            if (line.empty()) continue;

            if (StartsWith(line, "o ")) {
                currentObject = FindOrCreateObject(line.substr(2));
                continue;
            }

            if (StartsWith(line, "vt ")) {
                Float2 texCoord;
                std::stringstream ss(line.substr(3));
                ss >> texCoord.x >> texCoord.y;
                if (currentObject != nullptr)
                    currentObject->m_texCoords.push_back(texCoord);
                continue;
            }

            if (StartsWith(line, "vn ")) {
                Float3 normal;
                std::stringstream ss(line.substr(2));
                ss >> normal.x >> normal.y >> normal.z;
                if (currentObject != nullptr)
                    currentObject->m_normals.push_back(normal);
                continue;
            }

            if (StartsWith(line, "v ")) {
                Float3 vertex;
                std::stringstream ss(line.substr(1));
                ss >> vertex.x >> vertex.y >> vertex.z;
                if (currentObject != nullptr)
                    currentObject->m_vertices.push_back(vertex);
                continue;
            }

            if (StartsWith(line, "f "))
            {
                std::string tokens[3];
                std::stringstream stringStream(line.substr(2));
                stringStream >> tokens[0] >> tokens[1] >> tokens[2];

                Object::FaceElementIndices v{}, n{}, t{};
                bool hasNormals = false, hasTexCoords = false;

                for (int i = 0; i < 3; ++i)
                {
                    std::string& token = tokens[i];
                    size_t s1 = token.find('/');
                    size_t s2 = token.find('/', s1 + 1);

                    v.Values[i] = std::stoi(token.substr(0, s1));

                    if (s1 != std::string::npos && s2 != std::string::npos)
                    {
                        std::string texCoordStr = token.substr(s1 + 1, s2 - s1 - 1);
                        std::string normalStr = token.substr(s2 + 1);

                        if (!texCoordStr.empty())
                        {
                            t.Values[i] = std::stoi(texCoordStr);
                            hasTexCoords = true;
                        }
                        if (!normalStr.empty())
                        {
                            n.Values[i] = std::stoi(normalStr);
                            hasNormals = true;
                        }
                    }
                    else if (s1 != std::string::npos)
                    {
                        std::string texCoordStr = token.substr(s1 + 1);
                        if (!texCoordStr.empty())
                        {
                            t.Values[i] = std::stoi(texCoordStr);
                            hasTexCoords = true;
                        }
                    }
                }

                if (currentObject == nullptr)
                    continue;
                if (hasNormals && hasTexCoords)
                    currentObject->AddObjFace(v, n, t);
                else if (hasNormals)
                    currentObject->AddObjFace(v, n);
                else
                    currentObject->AddObjFace(v);
            }
        }
    }

    // ObjModelLoader::GetObjectVerticesAndIndices, into fresh vertices and indices. False if the
    // object is missing or names a missing position.
    bool GetObjectVerticesAndIndices(std::string const& name, float scale)
    {
        vertices.clear();
        indices.clear();
        Object* obj = GetObject(name);
        if (!obj)
            return false;

        for (const auto& face : obj->m_faces)
        {
            for (int vertexIndex = 0; vertexIndex < 3; ++vertexIndex)
            {
                Vertex v{};

                // Get vertex position
                uint32_t index = face.VertexIndices.Values[vertexIndex] - 1; // 1-indexed
                if (index >= obj->m_vertices.size())
                    return false;

                v.position = obj->m_vertices.at(index);
                v.position.x *= scale;
                v.position.y *= scale;
                v.position.z *= scale;

                // Get normal if available
                if (face.UseNormals)
                {
                    uint32_t normalIndex = face.NormalIndices.Values[vertexIndex] - 1;
                    v.normal = obj->m_normals[normalIndex];
                }

                // Get texture coordinate if available
                if (face.UseTexCoords)
                {
                    uint32_t texIndex = face.TexCoordIndices.Values[vertexIndex] - 1;
                    Float2 texCoord = obj->m_texCoords[texIndex];
                    v.uv.x = texCoord.x;
                    v.uv.y = texCoord.y;
                }
                else
                {
                    // Default UV
                    v.uv.x = 0.5f;
                    v.uv.y = 0.5f;
                }

                indices.push_back(static_cast<uint32_t>(vertices.size()));
                vertices.push_back(v);
            }
        }
        return true;
    }
};

extern "C"
{
    // An empty OBJ loader. Free it with Donut_DestroyObjModel.
    ObjModel* Donut_CreateObjModel()
    {
        return new ObjModel();
    }

    void Donut_DestroyObjModel(ObjModel* objModel)
    {
        delete objModel;
    }

    // Parses an OBJ file's byteSize bytes of text into the loader, as ObjModelLoader::Load: its
    // objects are added, or continued if their names were met before.
    void Donut_ParseObjModel(ObjModel* objModel, const void* data, int byteSize)
    {
        std::istringstream stream(std::string(static_cast<const char*>(data), static_cast<size_t>(byteSize)));
        objModel->Load(stream);
    }

    // The mesh of an object, its positions multiplied by scale: three vertices per triangle and
    // their indices (0, 1, 2, ...). Returns its vertex count, -1 if the object is missing or broken.
    int Donut_BuildObjModelMesh(ObjModel* objModel, const char* name, double scale)
    {
        if (!objModel->GetObjectVerticesAndIndices(name, static_cast<float>(scale)))
            return -1;
        return static_cast<int>(objModel->vertices.size());
    }

    int Donut_GetObjModelMeshIndexCount(ObjModel* objModel)
    {
        return static_cast<int>(objModel->indices.size());
    }

    // The mesh's vertices into dst: 9 floats each (position, normal, uv as float3s: 36 bytes).
    void Donut_CopyObjModelMeshVertices(ObjModel* objModel, void* dst)
    {
        memcpy(dst, objModel->vertices.data(), objModel->vertices.size() * sizeof(Vertex));
    }

    // The mesh's 32-bit indices into dst.
    void Donut_CopyObjModelMeshIndices(ObjModel* objModel, void* dst)
    {
        memcpy(dst, objModel->indices.data(), objModel->indices.size() * sizeof(uint32_t));
    }
}

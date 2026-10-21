// C++ helpers of the denoised_rtao example (DirectX-Graphics-Samples'
// D3D12RaytracingRealTimeDenoisedAmbientOcclusion): its PBRT scenes, loaded with the sample's own
// parser (core/pbrt, based on DuosRenderer) into the sample's vertex layout, and its RTAO sample
// sets, made by the sample's multi-jittered sampler. Both use the C++ standard library's random
// engine and distributions (MSVC's), as the sample does, so they come out the same.
//
// Copyright (c) Microsoft. All rights reserved.
// This code is licensed under the MIT License (MIT).

#include "pbrt/pbrt_stdafx.h"
#include "pbrt/PBRTParser.h"

#include <cstdio>
#include <cstring>
#include <numeric>
#include <random>
#include <wincodec.h>

#include "donut_api.h"

#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "ole32.lib")

namespace
{
    // The sample's PrimitiveMaterialBuffer (RaytracingHlslCompat.h): 96 bytes.
    struct PrimitiveMaterialBuffer
    {
        XMFLOAT3 Kd;
        XMFLOAT3 Ks;
        XMFLOAT3 Kr;
        XMFLOAT3 Kt;
        XMFLOAT3 opacity;
        XMFLOAT3 eta;
        float roughness;
        BOOL hasDiffuseTexture;
        BOOL hasNormalTexture;
        BOOL hasPerVertexTangents;
        MaterialType::Type type;
        float padding;
    };
    static_assert(sizeof(PrimitiveMaterialBuffer) == 96, "PrimitiveMaterialBuffer layout");

    // The sample's VertexPositionNormalTextureTangent: 44 bytes.
    struct VertexPositionNormalTextureTangent
    {
        XMFLOAT3 position;
        XMFLOAT3 normal;
        XMFLOAT2 textureCoordinate;
        XMFLOAT3 tangent;
    };
    static_assert(sizeof(VertexPositionNormalTextureTangent) == 44, "VertexPositionNormalTextureTangent layout");

    // A loaded scene's meshes with vertices and indices (Scene::LoadPBRTScene skips the others),
    // as Scene::LoadPBRTScene makes their buffers and material.
    struct PbrtMesh
    {
        std::vector<VertexPositionNormalTextureTangent> vertices;
        std::vector<UINT> indices;
        PrimitiveMaterialBuffer material;
        std::string diffuseTexture;
        std::string normalTexture;
    };

    struct PbrtScene
    {
        std::vector<PbrtMesh> meshes;
    };

    // RTAO/Sampler.h and Sampler.cpp: Samplers::Sampler and Samplers::MultiJittered.
    class MultiJitteredSampler
    {
    public:
        static const UINT s_seed = 1729;

        // Resets the sampler with newly randomly generated samples
        void Reset(UINT numSamples, UINT numSampleSets, float cosDensityPower)
        {
            m_index = 0;
            m_numSamples = numSamples;
            m_numSampleSets = numSampleSets;
            m_samples.resize(m_numSamples * m_numSampleSets, XMFLOAT2(FLT_MAX, FLT_MAX));
            m_shuffledIndices.resize(m_numSamples * m_numSampleSets);
            m_hemisphereSamples.resize(m_numSamples * m_numSampleSets, XMFLOAT3(FLT_MAX, FLT_MAX, FLT_MAX));

            // Reset generator and initialize distributions.
            {
                // Initialize to the same seed for determinism.
                m_generatorURNG.seed(s_seed);

                std::uniform_int_distribution<UINT> jumpDistribution(0, m_numSamples - 1);
                std::uniform_int_distribution<UINT> jumpSetDistribution(0, m_numSampleSets - 1);

                std::uniform_real_distribution<float> unitSquareDistribution(0.f, 1.f);

                // Specify the next representable value for the end range, since
                // uniform_real_distribution constructs excluding the end value [being, end).
                std::uniform_real_distribution<float> unitSquareDistributionInclusive(0.f, nextafter(1.f, FLT_MAX));

                GetRandomJump = std::bind(jumpDistribution, std::ref(m_generatorURNG));
                GetRandomSetJump = std::bind(jumpSetDistribution, std::ref(m_generatorURNG));
                GetRandomFloat01 = std::bind(unitSquareDistribution, std::ref(m_generatorURNG));
                GetRandomFloat01inclusive = std::bind(unitSquareDistributionInclusive, std::ref(m_generatorURNG));
            }

            // Generate random samples.
            {
                GenerateSamples2D();
                InitializeHemisphereSamples(cosDensityPower);

                for (UINT i = 0; i < m_numSampleSets; i++)
                {
                    auto first = begin(m_shuffledIndices) + i * m_numSamples;
                    auto last = first + m_numSamples;

                    std::iota(first, last, 0u); // Fill with 0, 1, ..., m_numSamples - 1
                    std::shuffle(first, last, m_generatorURNG);
                }
            }
        }

        XMFLOAT3 GetHemisphereSample3D()
        {
            return m_hemisphereSamples[GetSampleIndex()];
        }

    private:
        // Get a valid index from <0, m_numSampleSets * m_numSamples>.
        // The index increases by 1 on each call, but on a first
        // access of a next sample set, the:
        // - sample set is randomly picked
        // - sample set is indexed from a random starting index within a set.
        // In addition the order of indices is retrieved from shuffledIndices.
        UINT GetSampleIndex()
        {
            // Initialize sample and set jumps.
            if (m_index % m_numSamples == 0)
            {
                // Pick a random index jump within a set.
                m_jump = GetRandomJump();

                // Pick a random set index jump.
                m_setJump = GetRandomSetJump() * m_numSamples;
            }
            return m_setJump + m_shuffledIndices[(m_index++ + m_jump) % m_numSamples];
        }

        XMFLOAT2 RandomFloat01_2D()
        {
            return XMFLOAT2(GetRandomFloat01(), GetRandomFloat01());
        }

        UINT GetRandomNumber(UINT min, UINT max)
        {
            std::uniform_int_distribution<UINT> distribution(min, max);
            return distribution(m_generatorURNG);
        }

        // Initialize samples on a 3D hemisphere from 2D unit square samples
        // cosDensityPower - cosine density power {0, 1, ...}. 0:uniform, 1:cosine,...
        void InitializeHemisphereSamples(float cosDensityPower)
        {
            for (UINT i = 0; i < m_samples.size(); i++)
            {
                // Optimized version using trigonometry equations.
                float cosTheta = powf((1.f - m_samples[i].y), 1.f / (cosDensityPower + 1));
                float sinTheta = sqrtf(1.f - cosTheta * cosTheta);
                m_hemisphereSamples[i].x = sinTheta * cosf(XM_2PI * m_samples[i].x);
                m_hemisphereSamples[i].y = sinTheta * sinf(XM_2PI * m_samples[i].x);
                m_hemisphereSamples[i].z = cosTheta;
            }
        }

        // Generate multi-jittered sample patterns on a unit square [0,1].
        // Ref: Section 5.3.4 in Ray Tracing from the Ground Up.
        void GenerateSamples2D()
        {
            for (UINT s = 0; s < m_numSampleSets; s++)
            {
                // Generate samples on 2 level grid, with one sample per each (x,y)
                UINT sampleSetStartID = s * m_numSamples;

                const UINT T = m_numSamples;
                const UINT N = static_cast<UINT>(sqrt(T));

#define SAMPLE(i) m_samples[sampleSetStartID + i]

                // Generate random samples
                for (UINT col = 0, i = 0; col < N; col++)
                    for (UINT row = 0; row < N; row++, i++)
                    {
                        XMFLOAT2 stratum(static_cast<float>(row), static_cast<float>(col));
                        XMFLOAT2 cell(static_cast<float>(col), static_cast<float>(row));
                        XMFLOAT2 randomValue01 = RandomFloat01_2D();

                        SAMPLE(i).x = (randomValue01.x + cell.x) / T + stratum.x / N;
                        SAMPLE(i).y = (randomValue01.y + cell.y) / T + stratum.y / N;
                    }

                // Shuffle sample axes such that there's a sample in each stratum
                // and n-rooks is maintained.

                // Shuffle x coordinate across rows within a column
                for (UINT row = 0; row < N - 1; row++)
                    for (UINT col = 0; col < N; col++)
                    {
                        UINT k = GetRandomNumber(row + 1, N - 1);
                        std::swap(SAMPLE(row * N + col).x, SAMPLE(k * N + col).x);
                    }

                // Shuffle y coordinate across columns within a row
                for (UINT row = 0; row < N; row++)
                    for (UINT col = 0; col < N - 1; col++)
                    {
                        UINT k = GetRandomNumber(col + 1, N - 1);
                        std::swap(SAMPLE(row * N + col).y, SAMPLE(row * N + k).y);
                    }
#undef SAMPLE
            }
        }

        std::mt19937 m_generatorURNG;
        UINT m_numSamples = 0;
        UINT m_numSampleSets = 0;
        UINT m_index = 0;
        UINT m_jump = 0;
        UINT m_setJump = 0;
        std::vector<XMFLOAT2> m_samples;
        std::vector<XMFLOAT3> m_hemisphereSamples;
        std::vector<UINT> m_shuffledIndices;
        std::function<UINT()> GetRandomJump;
        std::function<UINT()> GetRandomSetJump;
        std::function<float()> GetRandomFloat01;
        std::function<float()> GetRandomFloat01inclusive;
    };
}

extern "C"
{
    // Loads a PBRT scene (the subset of the format the sample's scenes use: shapes in PLY files,
    // named materials, image map textures, transforms) with the sample's parser, as
    // Scene::LoadPBRTScene does: the meshes with vertices and indices, their positions and normals
    // transformed by their transform, their materials as PrimitiveMaterialBuffer. Null (after
    // printing why) on failure; free it with Donut_DestroyPbrtScene.
    DONUT_API PbrtScene* Donut_LoadPbrtScene(const char* path)
    {
        SceneParser::Scene pbrtScene;
        // The parser finds the PLY files next to the scene by the last backslash.
        std::string scenePath = path;
        std::replace(scenePath.begin(), scenePath.end(), '/', '\\');
        // The parser only asserts on a missing file (and parses an empty scene).
        if (!std::ifstream(scenePath).good())
        {
            fprintf(stderr, "Donut_LoadPbrtScene: cannot open %s\n", path);
            return nullptr;
        }
        try
        {
            PBRTParser::PBRTParser().Parse(scenePath, pbrtScene);
        }
        catch (const std::exception& e)
        {
            fprintf(stderr, "Donut_LoadPbrtScene: cannot load %s (%s)\n", path, e.what());
            return nullptr;
        }
        catch (...)
        {
            fprintf(stderr, "Donut_LoadPbrtScene: cannot load %s\n", path);
            return nullptr;
        }

        auto* scene = new PbrtScene();
        for (auto& mesh : pbrtScene.m_Meshes)
        {
            if (mesh.m_VertexBuffer.size() == 0 || mesh.m_IndexBuffer.size() == 0)
            {
                continue;
            }
            PbrtMesh out;
            out.indices.assign(mesh.m_IndexBuffer.begin(), mesh.m_IndexBuffer.end());
            out.vertices.reserve(mesh.m_VertexBuffer.size());
            for (auto& parseVertex : mesh.m_VertexBuffer)
            {
                VertexPositionNormalTextureTangent vertex;

                // Apply the initial transform to VB attributes.
                XMStoreFloat3(&vertex.normal, XMVector3TransformNormal(parseVertex.Normal.GetXMVECTOR(), mesh.m_transform));
                XMStoreFloat3(&vertex.position, XMVector3TransformCoord(parseVertex.Position.GetXMVECTOR(), mesh.m_transform));

                vertex.tangent = parseVertex.Tangent.xmFloat3;
                vertex.textureCoordinate = parseVertex.UV.xmFloat2;
                out.vertices.push_back(vertex);
            }

            PrimitiveMaterialBuffer& cb = out.material;
            cb.Kd = mesh.m_pMaterial->m_Kd.xmFloat3;
            cb.Ks = mesh.m_pMaterial->m_Ks.xmFloat3;
            cb.Kr = mesh.m_pMaterial->m_Kr.xmFloat3;
            cb.Kt = mesh.m_pMaterial->m_Kt.xmFloat3;
            cb.opacity = mesh.m_pMaterial->m_Opacity.xmFloat3;
            cb.eta = mesh.m_pMaterial->m_Eta.xmFloat3;
            cb.roughness = mesh.m_pMaterial->m_Roughness;
            cb.hasDiffuseTexture = !mesh.m_pMaterial->m_DiffuseTextureFilename.empty();
            cb.hasNormalTexture = !mesh.m_pMaterial->m_NormalMapTextureFilename.empty();
            cb.hasPerVertexTangents = true;
            cb.type = mesh.m_pMaterial->m_Type;
            cb.padding = 0;
            out.diffuseTexture = mesh.m_pMaterial->m_DiffuseTextureFilename;
            out.normalTexture = mesh.m_pMaterial->m_NormalMapTextureFilename;
            scene->meshes.push_back(std::move(out));
        }
        return scene;
    }

    DONUT_API void Donut_DestroyPbrtScene(PbrtScene* scene)
    {
        delete scene;
    }

    DONUT_API int Donut_GetPbrtSceneMeshCount(PbrtScene* scene)
    {
        return static_cast<int>(scene->meshes.size());
    }

    DONUT_API int Donut_GetPbrtMeshVertexCount(PbrtScene* scene, int mesh)
    {
        return static_cast<int>(scene->meshes[mesh].vertices.size());
    }

    DONUT_API int Donut_GetPbrtMeshIndexCount(PbrtScene* scene, int mesh)
    {
        return static_cast<int>(scene->meshes[mesh].indices.size());
    }

    // Copies a mesh's vertices into dst: 11 floats each (position, normal, texture coordinates,
    // tangent; 44 bytes, the sample's VertexPositionNormalTextureTangent).
    DONUT_API void Donut_CopyPbrtMeshVertices(PbrtScene* scene, int mesh, float* dst)
    {
        const auto& vertices = scene->meshes[mesh].vertices;
        memcpy(dst, vertices.data(), vertices.size() * sizeof(VertexPositionNormalTextureTangent));
    }

    // Copies a mesh's 32-bit indices into dst.
    DONUT_API void Donut_CopyPbrtMeshIndices(PbrtScene* scene, int mesh, int* dst)
    {
        const auto& indices = scene->meshes[mesh].indices;
        memcpy(dst, indices.data(), indices.size() * sizeof(UINT));
    }

    // Copies a mesh's material into dst: the sample's PrimitiveMaterialBuffer, 24 floats / ints
    // (Kd, Ks, Kr, Kt, opacity, eta as float3s, roughness, then the ints hasDiffuseTexture,
    // hasNormalTexture, hasPerVertexTangents, type, and padding).
    DONUT_API void Donut_CopyPbrtMeshMaterial(PbrtScene* scene, int mesh, void* dst)
    {
        memcpy(dst, &scene->meshes[mesh].material, sizeof(PrimitiveMaterialBuffer));
    }

    // Non-zero if a mesh's geometry is opaque, as Scene::LoadPBRTScene flags it: unless it's
    // see-through (opacity below 0.99) or a perfect mirror (which AO rays then skip as occluders).
    DONUT_API int Donut_IsPbrtMeshOpaque(PbrtScene* scene, int mesh)
    {
        const auto& cb = scene->meshes[mesh].material;
        return cb.opacity.x > 0.99f && cb.opacity.y > 0.99f && cb.opacity.z > 0.99f &&
            !(cb.type == MaterialType::Mirror && cb.Kr.x > 0.99f && cb.Kr.y > 0.99f && cb.Kr.z > 0.99f);
    }

    // A mesh's diffuse and normal map texture files (full paths, as the scene's file names them),
    // "" for none. Valid as long as the scene.
    DONUT_API const char* Donut_GetPbrtMeshDiffuseTexture(PbrtScene* scene, int mesh)
    {
        return scene->meshes[mesh].diffuseTexture.c_str();
    }

    DONUT_API const char* Donut_GetPbrtMeshNormalTexture(PbrtScene* scene, int mesh)
    {
        return scene->meshes[mesh].normalTexture.c_str();
    }

    // Decodes an image file with WIC into 8-bit RGBA, as DirectXTK's WIC texture loader does for
    // the sample (its JPEG decoder differs a little from Donut's): width x height x 4 bytes into
    // dst (Ref of a `let` int array element, room for width x height ints), or with dst null only
    // the size. Returns width | height << 16, 0 on failure.
    DONUT_API int Donut_DecodeWicImageRGBA8(const char* path, int* dst)
    {
        static bool comInitialized = false;
        if (!comInitialized)
        {
            CoInitializeEx(nullptr, COINIT_MULTITHREADED);
            comInitialized = true;
        }
        IWICImagingFactory* factory = nullptr;
        if (FAILED(CoCreateInstance(CLSID_WICImagingFactory2, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory))))
            return 0;
        const int length = MultiByteToWideChar(CP_UTF8, 0, path, -1, nullptr, 0);
        std::wstring widePath(length > 0 ? length - 1 : 0, L'\0');
        MultiByteToWideChar(CP_UTF8, 0, path, -1, widePath.data(), length);

        int result = 0;
        IWICBitmapDecoder* decoder = nullptr;
        IWICBitmapFrameDecode* frame = nullptr;
        IWICFormatConverter* converter = nullptr;
        UINT width = 0, height = 0;
        if (SUCCEEDED(factory->CreateDecoderFromFilename(widePath.c_str(), nullptr, GENERIC_READ, WICDecodeMetadataCacheOnDemand, &decoder)) &&
            SUCCEEDED(decoder->GetFrame(0, &frame)) &&
            SUCCEEDED(frame->GetSize(&width, &height)) &&
            SUCCEEDED(factory->CreateFormatConverter(&converter)) &&
            SUCCEEDED(converter->Initialize(frame, GUID_WICPixelFormat32bppRGBA, WICBitmapDitherTypeErrorDiffusion, nullptr, 0, WICBitmapPaletteTypeMedianCut)))
        {
            if (dst == nullptr || SUCCEEDED(converter->CopyPixels(nullptr, width * 4, width * height * 4, reinterpret_cast<BYTE*>(dst))))
                result = static_cast<int>(width | (height << 16));
        }
        if (converter) converter->Release();
        if (frame) frame->Release();
        if (decoder) decoder->Release();
        factory->Release();
        return result;
    }

    // The sample's RTAO sample sets (RTAO::CreateSamplesRNG): numSampleSets sets of samplesPerSet
    // multi-jittered samples on the cosine-weighted hemisphere (Samplers::MultiJittered, seeded
    // with 1729), taken one by one with GetHemisphereSample3D as the sample fills its buffer: 4
    // floats each (x, y, z, 0: AlignedHemisphereSample3D) into dst.
    DONUT_API void Donut_GenerateRtaoHemisphereSamples(int samplesPerSet, int numSampleSets, float* dst)
    {
        MultiJitteredSampler sampler;
        sampler.Reset(static_cast<UINT>(samplesPerSet), static_cast<UINT>(numSampleSets), 1.f);
        const int count = samplesPerSet * numSampleSets;
        for (int i = 0; i < count; i++)
        {
            XMFLOAT3 p = sampler.GetHemisphereSample3D();
            dst[i * 4 + 0] = p.x;
            dst[i * 4 + 1] = p.y;
            dst[i * 4 + 2] = p.z;
            dst[i * 4 + 3] = 0.f;
        }
    }
}

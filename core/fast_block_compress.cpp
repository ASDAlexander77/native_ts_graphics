// The Xbox ATG FastBlockCompress sample's CPU side for TypeScript (fast_block_compress links it, with
// the sample's CPU compressor, fbc_cpu.cpp; see CMakeLists.txt): its DDS images as RGBA8 levels in
// the layout that compressor reads, and its CPU compression, timed. Functions of no Donut object,
// so donut.ts doesn't wrap them and other examples don't link them.

#include "fbc_cpu_compat.h"
#include "fbc_cpu.h"

#include <chrono>
#include <cstdio>

namespace
{
    // The block-compressed formats of Donut_FbcCompressCpu: nvrhi::Format values (Format in
    // donut_interop.d.ts).
    enum FbcFormat
    {
        FbcFormat_BC1 = 56,
        FbcFormat_BC3 = 60,
        FbcFormat_BC5 = 64,
    };

    // A square texture's levels on the CPU, each 16-byte aligned: RGBA8 images or block-compressed
    // data.
    struct FbcTexture
    {
        uint32_t width = 0;
        std::unique_ptr<uint8_t, aligned_deleter> memory;
        std::vector<D3D12_SUBRESOURCE_DATA> levels;
    };

    inline uint32_t Swizzle(uint32_t t, bool ignorealpha)
    {
        uint32_t t1 = (t & 0x00ff0000) >> 16;
        uint32_t t2 = (t & 0x000000ff) << 16;
        uint32_t t3 = (t & 0x0000ff00);
        uint32_t ta = ignorealpha ? 0xff000000 : (t & 0xFF000000);

        return (t1 | t2 | t3 | ta);
    }

    inline uintptr_t AlignUp16(uintptr_t value)
    {
        return (value + 15) & ~uintptr_t(15);
    }

    // The sample's Image::MakeRGBATexture: the levels in the CPU compressor's layout (RGBA8, each
    // level 16-byte aligned with a natural pitch, the 2x2 and 1x1 levels replicated to 4x4), BGR
    // swapped to RGB, alpha 255 if ignorealpha (B8G8R8X8 sources).
    void MakeRGBATexture(FbcTexture& texture, uint32_t texSize, uint32_t levels, const uint8_t* source, bool swizzle,
        bool ignorealpha)
    {
        size_t totalSize = 0;
        for (uint32_t level = 0; level < levels; ++level)
        {
            uint32_t mipSize = std::max(texSize >> level, 4u);
            totalSize += AlignUp16(mipSize * mipSize * 4);
        }

        auto mem = static_cast<uint8_t*>(FbcAlignedMalloc(totalSize, 16));
        texture.memory.reset(mem);
        texture.levels.clear();

        uint8_t* destPtr = mem;
        const uint8_t* srcPtr = source;
        for (uint32_t level = 0; level < levels; ++level)
        {
            uint32_t mipSize = std::max(texSize >> level, 1u);
            uint32_t targetMipSize = std::max(texSize >> level, 4u);

            D3D12_SUBRESOURCE_DATA rgba;
            rgba.pData = destPtr;
            rgba.RowPitch = targetMipSize * 4;
            rgba.SlicePitch = targetMipSize * targetMipSize * 4;
            texture.levels.push_back(rgba);

            // DDS levels follow each other with natural pitches.
            const uint32_t rowPitch = mipSize * 4;
            auto pixel = [&](uint32_t x, uint32_t y)
            {
                uint32_t p;
                memcpy(&p, srcPtr + y * rowPitch + x * 4, 4);
                return swizzle ? Swizzle(p, ignorealpha) : p;
            };

            if (mipSize >= 4)
            {
                for (uint32_t y = 0; y < mipSize; ++y)
                {
                    for (uint32_t x = 0; x < mipSize; ++x)
                    {
                        uint32_t p = pixel(x, y);
                        memcpy(destPtr, &p, 4);
                        destPtr += 4;
                    }
                }
            }
            else
            {
                // 2x2 replicate pattern (originally used by D3DX); 1x1 replicated to all 16.
                // 0 1 0 1
                // 2 3 2 3
                // 0 1 0 1
                // 2 3 2 3
                for (uint32_t y = 0; y < 4; ++y)
                {
                    for (uint32_t x = 0; x < 4; ++x)
                    {
                        uint32_t p = pixel(x % mipSize, y % mipSize);
                        memcpy(destPtr, &p, 4);
                        destPtr += 4;
                    }
                }
            }

            srcPtr += size_t(rowPitch) * mipSize;
            destPtr = reinterpret_cast<uint8_t*>(AlignUp16(reinterpret_cast<uintptr_t>(destPtr)));
        }
    }

    DXGI_FORMAT ToDxgiFormat(int format)
    {
        switch (format)
        {
        case FbcFormat_BC1: return DXGI_FORMAT_BC1_UNORM;
        case FbcFormat_BC3: return DXGI_FORMAT_BC3_UNORM;
        case FbcFormat_BC5: return DXGI_FORMAT_BC5_UNORM;
        default: return DXGI_FORMAT_UNKNOWN;
        }
    }

    double MillisecondsSince(std::chrono::high_resolution_clock::time_point start)
    {
        return std::chrono::duration<double, std::milli>(std::chrono::high_resolution_clock::now() - start).count();
    }
}

extern "C"
{
    // Decodes a DDS file in memory (byteSize bytes) of the sample's kind: square, a power of two,
    // 32-bit B8G8R8A8, B8G8R8X8 or R8G8B8A8 (a legacy header), every level. The levels come out as
    // RGBA8 (X8 alpha read as 255, as D3D does), in the sample's CPU compressor layout: 16-byte
    // aligned, natural pitches, the 2x2 and 1x1 levels replicated to 4x4 (their top-left 2x2 / 1x1
    // texels are the level). Returns null (after printing why) on failure; free it with
    // Donut_DestroyFbcTexture.
    FbcTexture* Donut_FbcDecodeDds(const void* data, int byteSize)
    {
        const auto* bytes = static_cast<const uint8_t*>(data);
        auto u32 = [bytes](size_t offset)
        {
            uint32_t v;
            memcpy(&v, bytes + offset, 4);
            return v;
        };

        if (byteSize < 128 || u32(0) != 0x20534444) // "DDS "
        {
            fprintf(stderr, "Donut_FbcDecodeDds: not a DDS file\n");
            return nullptr;
        }
        const uint32_t height = u32(12);
        const uint32_t width = u32(16);
        const uint32_t levels = std::max(u32(28), 1u);
        const uint32_t pixelFlags = u32(80);
        const uint32_t bitCount = u32(88);
        const uint32_t redMask = u32(92);
        const uint32_t greenMask = u32(96);
        const uint32_t blueMask = u32(100);
        const uint32_t alphaMask = u32(104);

        // DDPF_RGB, 32 bits per pixel.
        if ((pixelFlags & 0x40) == 0 || bitCount != 32 || greenMask != 0xff00)
        {
            fprintf(stderr, "Donut_FbcDecodeDds: unsupported source format\n");
            return nullptr;
        }
        bool swizzle;
        if (redMask == 0xff0000 && blueMask == 0xff)
            swizzle = true;     // B8G8R8A8 / B8G8R8X8
        else if (redMask == 0xff && blueMask == 0xff0000)
            swizzle = false;    // R8G8B8A8
        else
        {
            fprintf(stderr, "Donut_FbcDecodeDds: unsupported source format\n");
            return nullptr;
        }
        // No alpha bits: B8G8R8X8.
        const bool ignoreAlpha = swizzle && alphaMask == 0;

        if (width != height || width <= 16 || (width & (width - 1)) != 0 || levels > D3D12_REQ_MIP_LEVELS)
        {
            fprintf(stderr, "Donut_FbcDecodeDds: the sample supports square, power-of-two textures larger than 16x16\n");
            return nullptr;
        }

        size_t dataSize = 0;
        for (uint32_t level = 0; level < levels; ++level)
        {
            const size_t mipSize = std::max(width >> level, 1u);
            dataSize += mipSize * mipSize * 4;
        }
        if (size_t(byteSize) < 128 + dataSize)
        {
            fprintf(stderr, "Donut_FbcDecodeDds: not enough source data\n");
            return nullptr;
        }

        auto texture = new FbcTexture;
        texture->width = width;
        MakeRGBATexture(*texture, width, levels, bytes + 128, swizzle, ignoreAlpha);
        return texture;
    }

    // The sample's CPU compression of an image (Donut_FbcDecodeDds) into format (BC1_UNORM,
    // BC3_UNORM or BC5_UNORM, nvrhi::Format values): its top level alone, timed, then all levels,
    // timed; stats gets the milliseconds of each (Ref of a `let` f32 array of 2). Returns the levels
    // compressed (rows of 4x4 blocks), or null (after printing why) on failure; free it with
    // Donut_DestroyFbcTexture.
    FbcTexture* Donut_FbcCompressCpu(FbcTexture* fbcTexture, int format, float* stats)
    {
        const FbcTexture* image = fbcTexture;
        const DXGI_FORMAT bcFormat = ToDxgiFormat(format);
        const uint32_t levels = static_cast<uint32_t>(image->levels.size());

        CompressorCPU compressor;
        auto result = new FbcTexture;
        result->width = image->width;

        // First compress the top mip alone (to calculate the compression time)
        FbcTexture top;
        HRESULT hr = compressor.Prepare(image->width, bcFormat, 1, top.memory, top.levels);
        if (hr == S_OK)
        {
            auto start = std::chrono::high_resolution_clock::now();
            hr = compressor.Compress(image->width, 1, image->levels.data(), bcFormat, top.levels.data());
            stats[0] = float(MillisecondsSince(start));
        }

        // Then compress all of the mips
        if (hr == S_OK)
            hr = compressor.Prepare(image->width, bcFormat, levels, result->memory, result->levels);
        if (hr == S_OK)
        {
            auto start = std::chrono::high_resolution_clock::now();
            hr = compressor.Compress(image->width, levels, image->levels.data(), bcFormat, result->levels.data());
            stats[1] = float(MillisecondsSince(start));
        }

        if (hr != S_OK)
        {
            fprintf(stderr, "Donut_FbcCompressCpu: compression failed (0x%08x)\n", unsigned(hr));
            delete result;
            return nullptr;
        }
        return result;
    }

    int Donut_GetFbcTextureWidth(FbcTexture* fbcTexture)
    {
        return static_cast<int>(fbcTexture->width);
    }

    int Donut_GetFbcTextureLevelCount(FbcTexture* fbcTexture)
    {
        return static_cast<int>(fbcTexture->levels.size());
    }

    // A level's data, its rows (of pixels, or of 4x4 blocks) rowPitch bytes apart, valid until the
    // texture is freed.
    const void* Donut_GetFbcTextureLevelData(FbcTexture* fbcTexture, int level)
    {
        return fbcTexture->levels[size_t(level)].pData;
    }

    int Donut_GetFbcTextureLevelRowPitch(FbcTexture* fbcTexture, int level)
    {
        return static_cast<int>(fbcTexture->levels[size_t(level)].RowPitch);
    }

    void Donut_DestroyFbcTexture(FbcTexture* fbcTexture)
    {
        delete fbcTexture;
    }
}

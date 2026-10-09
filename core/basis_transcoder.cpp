// Basis Universal transcoding of KTX 2 files for TypeScript (texture_compression_comparison links
// it, with Basis Universal's transcoder; see CMakeLists.txt): a file's levels transcoded into a GPU
// format and kept on the CPU, timed, for Donut_CreateTextureWithLevels and Donut_WriteTextureLevel
// to upload. Functions of no Donut object, so donut.ts doesn't wrap them and other examples don't
// link them.

#include <basisu_transcoder.h>

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <mutex>
#include <vector>

namespace
{
    // The formats of Donut_TranscodeKtx2: values of TranscodeFormat in donut_interop.d.ts.
    enum TranscodeFormat
    {
        TranscodeFormat_RGBA32 = 0,
        TranscodeFormat_BC7 = 1,
        TranscodeFormat_BC3 = 2,
        TranscodeFormat_ASTC4x4 = 3,
        TranscodeFormat_ETC2 = 4,
    };

    // A KTX 2 file's levels transcoded, one block row after the other.
    struct TranscodedTexture
    {
        uint32_t width = 0;
        uint32_t height = 0;
        struct Level
        {
            std::vector<uint8_t> data;
            uint32_t rowPitch = 0;
        };
        std::vector<Level> levels;
    };

    basist::transcoder_texture_format ToBasisFormat(int format)
    {
        switch (format)
        {
        case TranscodeFormat_BC7: return basist::transcoder_texture_format::cTFBC7_RGBA;
        case TranscodeFormat_BC3: return basist::transcoder_texture_format::cTFBC3_RGBA;
        case TranscodeFormat_ASTC4x4: return basist::transcoder_texture_format::cTFASTC_4x4_RGBA;
        case TranscodeFormat_ETC2: return basist::transcoder_texture_format::cTFETC2_RGBA;
        default: return basist::transcoder_texture_format::cTFRGBA32;
        }
    }
}

extern "C"
{
    // Transcodes the KTX 2 file in data (byteSize bytes; Basis Universal ETC1S or UASTC, with or
    // without Zstandard supercompression) into format (a TranscodeFormat value), every level, as
    // the Vulkan-Samples framework's ktxTexture2_TranscodeBasis. stats gets the time the transcoding
    // took, in milliseconds, and the transcoded bytes (Ref of a `let` f32 array of 2). Returns null
    // (after printing why) on failure; free it with Donut_DestroyTranscodedTexture.
    void* Donut_TranscodeKtx2(const void* data, int byteSize, int format, float* stats)
    {
        static std::once_flag initialized;
        std::call_once(initialized, [] { basist::basisu_transcoder_init(); });

        const auto start = std::chrono::high_resolution_clock::now();

        basist::ktx2_transcoder transcoder;
        if (!transcoder.init(data, static_cast<uint32_t>(byteSize)) || !transcoder.start_transcoding())
        {
            std::fprintf(stderr, "Cannot read the KTX 2 file (Basis Universal)\n");
            return nullptr;
        }

        const basist::transcoder_texture_format basisFormat = ToBasisFormat(format);
        const bool uncompressed = basist::basis_transcoder_format_is_uncompressed(basisFormat);
        const uint32_t bytesPerBlock = basist::basis_get_bytes_per_block_or_pixel(basisFormat);

        auto texture = std::make_unique<TranscodedTexture>();
        texture->width = transcoder.get_width();
        texture->height = transcoder.get_height();
        size_t totalBytes = 0;
        for (uint32_t level = 0; level < transcoder.get_levels(); level++)
        {
            basist::ktx2_image_level_info info;
            if (!transcoder.get_image_level_info(info, level, 0, 0))
                return nullptr;
            // Pixels for uncompressed formats, 4 x 4 blocks for the others.
            const uint32_t columns = uncompressed ? info.m_orig_width : info.m_num_blocks_x;
            const uint32_t rows = uncompressed ? info.m_orig_height : info.m_num_blocks_y;
            TranscodedTexture::Level& out = texture->levels.emplace_back();
            out.rowPitch = columns * bytesPerBlock;
            out.data.resize(static_cast<size_t>(out.rowPitch) * rows);
            if (!transcoder.transcode_image_level(level, 0, 0, out.data.data(), columns * rows, basisFormat, 0,
                    uncompressed ? columns : 0, uncompressed ? rows : 0))
            {
                std::fprintf(stderr, "Cannot transcode level %u of the KTX 2 file\n", level);
                return nullptr;
            }
            totalBytes += out.data.size();
        }

        const auto end = std::chrono::high_resolution_clock::now();
        stats[0] = static_cast<float>(std::chrono::duration_cast<std::chrono::microseconds>(end - start).count()) / 1000.f;
        stats[1] = static_cast<float>(totalBytes);
        return texture.release();
    }

    int Donut_GetTranscodedWidth(void* transcodedTexture)
    {
        return static_cast<int>(static_cast<TranscodedTexture*>(transcodedTexture)->width);
    }

    int Donut_GetTranscodedHeight(void* transcodedTexture)
    {
        return static_cast<int>(static_cast<TranscodedTexture*>(transcodedTexture)->height);
    }

    int Donut_GetTranscodedLevelCount(void* transcodedTexture)
    {
        return static_cast<int>(static_cast<TranscodedTexture*>(transcodedTexture)->levels.size());
    }

    // A level's data, block (or pixel) rows rowPitch bytes apart; valid until the texture is freed.
    const void* Donut_GetTranscodedLevelData(void* transcodedTexture, int level)
    {
        return static_cast<TranscodedTexture*>(transcodedTexture)->levels[static_cast<size_t>(level)].data.data();
    }

    int Donut_GetTranscodedLevelRowPitch(void* transcodedTexture, int level)
    {
        return static_cast<int>(static_cast<TranscodedTexture*>(transcodedTexture)->levels[static_cast<size_t>(level)].rowPitch);
    }

    void Donut_DestroyTranscodedTexture(void* transcodedTexture)
    {
        delete static_cast<TranscodedTexture*>(transcodedTexture);
    }
}

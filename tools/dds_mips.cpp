// Adds mip levels to RGBA8 DDS textures that have only their first level, as the Vulkan-Samples
// framework generates them for the ASTC textures it decodes (vkb::sg::Image::generate_mipmaps): each
// level resized from the previous one by stb_image_resize's stbir_resize_uint8 (its defaults: a
// Mitchell filter when downsampling, clamped edges, the bytes taken as linear), halving the size
// (at least 1), the chain ending before 1 x 1. Donut loads a DDS file's levels as they are, and
// generates none.
//
//     dds_mips <texture.dds> [<texture.dds> ...]
//
// Rewrites each file in place; files that already have mip levels are left alone. They are the
// ones tools/ktx_to_dds.py writes: a DX10 header, one 2D texture, R8G8B8A8_UNORM(_SRGB).

#define STB_IMAGE_RESIZE_IMPLEMENTATION
#include <stb_image_resize.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <thread>
#include <vector>

namespace
{
    // DDS_HEADER (after the "DDS " magic) and DDS_HEADER_DXT10, as ktx_to_dds.py writes them.
    constexpr size_t HeaderSize = 4 + 124 + 20;
    constexpr size_t FlagsOffset = 8;
    constexpr size_t HeightOffset = 12;
    constexpr size_t WidthOffset = 16;
    constexpr size_t MipCountOffset = 28;
    constexpr size_t CapsOffset = 108;
    constexpr size_t FourCCOffset = 84;
    constexpr size_t DxgiFormatOffset = 128;
    constexpr uint32_t DDSD_MIPMAPCOUNT = 0x20000;
    constexpr uint32_t DDSCAPS_COMPLEX = 0x8;
    constexpr uint32_t DDSCAPS_MIPMAP = 0x400000;
    constexpr uint32_t DXGI_R8G8B8A8_UNORM = 28;
    constexpr uint32_t DXGI_R8G8B8A8_UNORM_SRGB = 29;
    constexpr int Channels = 4;

    uint32_t Read32(const std::vector<uint8_t>& data, size_t offset)
    {
        uint32_t value;
        memcpy(&value, data.data() + offset, sizeof(value));
        return value;
    }

    void Write32(std::vector<uint8_t>& data, size_t offset, uint32_t value)
    {
        memcpy(data.data() + offset, &value, sizeof(value));
    }

    // Returns an error message, or "" on success.
    std::string AddMips(const std::string& path)
    {
        std::vector<uint8_t> data;
        {
            std::ifstream file(path, std::ios::binary);
            if (!file)
                return "cannot read the file";
            data.assign(std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>());
        }
        if (data.size() < HeaderSize || memcmp(data.data(), "DDS ", 4) != 0 || memcmp(data.data() + FourCCOffset, "DX10", 4) != 0)
            return "not a DDS file with a DX10 header";
        const uint32_t format = Read32(data, DxgiFormatOffset);
        if (format != DXGI_R8G8B8A8_UNORM && format != DXGI_R8G8B8A8_UNORM_SRGB)
            return "not an RGBA8 texture";
        if ((Read32(data, FlagsOffset) & DDSD_MIPMAPCOUNT) != 0 && Read32(data, MipCountOffset) > 1)
            return "";

        uint32_t width = Read32(data, WidthOffset);
        uint32_t height = Read32(data, HeightOffset);
        if (data.size() != HeaderSize + size_t(width) * height * Channels)
            return "not a single 2D texture of one level";

        // vkb::sg::Image::generate_mipmaps.
        std::vector<size_t> offsets = { HeaderSize };
        uint32_t nextWidth = std::max<uint32_t>(1u, width / 2);
        uint32_t nextHeight = std::max<uint32_t>(1u, height / 2);
        while (true)
        {
            const size_t offset = data.size();
            data.resize(offset + size_t(nextWidth) * nextHeight * Channels);
            if (!stbir_resize_uint8(data.data() + offsets.back(), int(width), int(height), 0,
                    data.data() + offset, int(nextWidth), int(nextHeight), 0, Channels))
                return "stbir_resize_uint8 failed";
            offsets.push_back(offset);

            width = nextWidth;
            height = nextHeight;
            nextWidth = std::max<uint32_t>(1u, nextWidth / 2);
            nextHeight = std::max<uint32_t>(1u, nextHeight / 2);
            if (nextWidth == 1 && nextHeight == 1)
                break;
        }

        Write32(data, FlagsOffset, Read32(data, FlagsOffset) | DDSD_MIPMAPCOUNT);
        Write32(data, MipCountOffset, uint32_t(offsets.size()));
        Write32(data, CapsOffset, Read32(data, CapsOffset) | DDSCAPS_COMPLEX | DDSCAPS_MIPMAP);

        std::ofstream file(path, std::ios::binary | std::ios::trunc);
        if (!file.write(reinterpret_cast<const char*>(data.data()), std::streamsize(data.size())))
            return "cannot write the file";
        return "";
    }
}

int main(int argc, char** argv)
{
    if (argc < 2)
    {
        fprintf(stderr, "usage: dds_mips <texture.dds> [<texture.dds> ...]\n");
        return 2;
    }

    // A thread per file: the big ones take a while.
    std::vector<std::string> errors(argc - 1);
    std::vector<std::thread> threads;
    for (int i = 1; i < argc; i++)
        threads.emplace_back([&errors, argv, i]() { errors[i - 1] = AddMips(argv[i]); });
    for (std::thread& thread : threads)
        thread.join();

    int result = 0;
    for (int i = 1; i < argc; i++)
    {
        if (!errors[i - 1].empty())
        {
            fprintf(stderr, "%s: %s\n", argv[i], errors[i - 1].c_str());
            result = 1;
        }
    }
    return result;
}

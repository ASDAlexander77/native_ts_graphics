"""Converts block-compressed DDS textures to KTX 2, the container Donut's texture cache also loads.

Donut reads KTX 2 files of BCn data (2D, with their mip levels; no supercompression or Zstandard),
which is what this writes: the DDS file's blocks, level by level, unchanged. With Python 3.14's
compression.zstd the levels are Zstandard-supercompressed (as KTX 2 tools usually write them), so
that path of the loader runs too; without it they are stored as they are.

Handles DX10-header DDS files of BC1-BC7 (UNORM, SRGB, SNORM, UF16 and SF16), 2D, one array slice.

    python tools/dds_to_ktx2.py <input.dds> <output.ktx2>
"""

import struct
import sys

try:
    import compression.zstd as zstd
except ImportError:
    zstd = None

KTX2_IDENTIFIER = b"\xabKTX 20\xbb\r\n\x1a\n"
KTX_SS_NONE = 0
KTX_SS_ZSTD = 2

# DXGI_FORMAT -> (VkFormat, bytes per 4x4 block, Khronos Data Format color model, transfer
# function (1 linear, 2 sRGB), sample channel type, sample qualifiers (KHR_DF_SAMPLE_DATATYPE_*:
# 0x4 signed, 0x8 float), sample upper value)
FORMATS = {
    71: (133, 8, 128, 1, 0, 0, 0xFFFFFFFF),          # BC1_UNORM -> BC1_RGBA_UNORM_BLOCK
    72: (134, 8, 128, 2, 0, 0, 0xFFFFFFFF),          # BC1_UNORM_SRGB -> BC1_RGBA_SRGB_BLOCK
    74: (135, 16, 129, 1, 0, 0, 0xFFFFFFFF),         # BC2_UNORM
    75: (136, 16, 129, 2, 0, 0, 0xFFFFFFFF),         # BC2_UNORM_SRGB
    77: (137, 16, 130, 1, 0, 0, 0xFFFFFFFF),         # BC3_UNORM
    78: (138, 16, 130, 2, 0, 0, 0xFFFFFFFF),         # BC3_UNORM_SRGB
    80: (139, 8, 131, 1, 0, 0, 0xFFFFFFFF),          # BC4_UNORM
    81: (140, 8, 131, 1, 0, 0x4, 0x7FFFFFFF),        # BC4_SNORM
    83: (141, 16, 132, 1, 0, 0, 0xFFFFFFFF),         # BC5_UNORM
    84: (142, 16, 132, 1, 0, 0x4, 0x7FFFFFFF),       # BC5_SNORM
    95: (143, 16, 133, 1, 0, 0x8, 0x7F800000),       # BC6H_UF16 -> BC6H_UFLOAT_BLOCK (upper: +inf)
    96: (144, 16, 133, 1, 0, 0xC, 0x7F800000),       # BC6H_SF16 -> BC6H_SFLOAT_BLOCK
    98: (145, 16, 134, 1, 0, 0, 0xFFFFFFFF),         # BC7_UNORM
    99: (146, 16, 134, 2, 0, 0, 0xFFFFFFFF),         # BC7_UNORM_SRGB
}


def read_dds(path):
    data = open(path, "rb").read()
    if data[:4] != b"DDS ":
        raise ValueError(f"{path}: not a DDS file")
    height, width = struct.unpack_from("<II", data, 12)
    mip_levels = max(1, struct.unpack_from("<I", data, 28)[0])
    if data[84:88] != b"DX10":
        raise ValueError(f"{path}: only DX10-header DDS files are handled")
    dxgi_format, dimension, misc_flag, array_size = struct.unpack_from("<4I", data, 128)
    if dimension != 3 or array_size != 1 or misc_flag & 0x4:
        raise ValueError(f"{path}: only 2D textures of one slice are handled")
    if dxgi_format not in FORMATS:
        raise ValueError(f"{path}: DXGI format {dxgi_format} isn't a handled BCn format")

    block_size = FORMATS[dxgi_format][1]
    levels = []
    offset = 148
    for level in range(mip_levels):
        w = max(1, width >> level)
        h = max(1, height >> level)
        size = max(1, (w + 3) // 4) * max(1, (h + 3) // 4) * block_size
        levels.append(data[offset:offset + size])
        if len(levels[-1]) != size:
            raise ValueError(f"{path}: truncated at mip level {level}")
        offset += size
    return width, height, dxgi_format, levels


def data_format_descriptor(dxgi_format):
    """A basic descriptor block: one sample covering the whole 4x4 block (KDF 1.3, section 5)."""
    _, block_size, color_model, transfer, channel, qualifiers, upper = FORMATS[dxgi_format]
    block = struct.pack("<II", 0, 2 | ((24 + 16) << 16))   # vendor 0, type 0; version 2, size
    block += bytes([color_model, 1, transfer, 0])           # BT.709 primaries, straight alpha
    block += bytes([3, 3, 0, 0])                            # texel block 4 x 4 (minus 1)
    block += bytes([block_size, 0, 0, 0, 0, 0, 0, 0])       # bytes per plane
    block += struct.pack("<HBB", 0, block_size * 8 - 1, channel | (qualifiers << 4))
    block += bytes([0, 0, 0, 0])                            # sample position
    block += struct.pack("<II", 0, upper)                   # sample lower, upper
    return struct.pack("<I", 4 + len(block)) + block


def write_ktx2(path, width, height, dxgi_format, levels):
    vk_format, block_size = FORMATS[dxgi_format][:2]
    scheme = KTX_SS_ZSTD if zstd else KTX_SS_NONE
    payloads = [zstd.compress(level, level=19) if zstd else level for level in levels]

    dfd = data_format_descriptor(dxgi_format)
    writer = b"KTXwriter\x00native_ts_graphics dds_to_ktx2.py\x00"
    kvd = struct.pack("<I", len(writer)) + writer
    kvd += b"\x00" * (-len(kvd) % 4)

    header_size = 80 + 24 * len(levels)
    dfd_offset = header_size
    kvd_offset = dfd_offset + len(dfd)
    data_start = kvd_offset + len(kvd)

    # Level data goes smallest level first, each aligned to lcm(block size, 4) (1 when
    # supercompressed).
    alignment = 1 if scheme != KTX_SS_NONE else block_size
    offsets = [0] * len(levels)
    body = b""
    for level in reversed(range(len(levels))):
        position = data_start + len(body)
        padding = -position % alignment
        body += b"\x00" * padding
        offsets[level] = data_start + len(body)
        body += payloads[level]

    out = KTX2_IDENTIFIER
    out += struct.pack("<9I", vk_format, 1, width, height, 0, 0, 1, len(levels), scheme)
    out += struct.pack("<4I2Q", dfd_offset, len(dfd), kvd_offset, len(kvd), 0, 0)
    for level in range(len(levels)):
        out += struct.pack("<3Q", offsets[level], len(payloads[level]), len(levels[level]))
    out += dfd + kvd + body
    open(path, "wb").write(out)


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 1
    width, height, dxgi_format, levels = read_dds(sys.argv[1])
    write_ktx2(sys.argv[2], width, height, dxgi_format, levels)
    return 0


if __name__ == "__main__":
    sys.exit(main())

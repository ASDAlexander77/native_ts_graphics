"""Converts KTX textures (as Vulkan-Samples ships them) to DDS, which Donut loads.

Donut's texture cache reads DDS, block-compressed KTX 2 and the usual image formats, not KTX 1. This
handles what the ported samples need:
- KTX 1, uncompressed: RGBA8 (linear or sRGB), R16 and RGBA16F data, 2D textures, 2D texture arrays and cube maps,
  with their mip levels;
- KTX 1, ASTC (LDR, 2D): decoded to RGBA8 (sRGB if the data is), level 0 only, as the
  Vulkan-Samples framework decodes ASTC textures on GPUs without ASTC support (it then generates
  the mip levels, as Donut does for textures that have none);
- KTX 2, uncompressed RGBA8 2D textures (no supercompression), with their mip levels;
- KTX 2, ASTC (LDR, 2D, no supercompression): decoded as KTX 1's, level 0 only.

    python tools/ktx_to_dds.py <input.ktx> <output.dds> [<input.ktx> <output.dds> ...]

Several textures convert in parallel, a process each.
"""

import concurrent.futures
import os
import struct
import sys

import astc

KTX_IDENTIFIER = b"\xabKTX 11\xbb\r\n\x1a\n"
KTX2_IDENTIFIER = b"\xabKTX 20\xbb\r\n\x1a\n"

# (glType, glFormat, glInternalFormat) -> (DXGI_FORMAT, bytes per texel)
FORMATS = {
    (0x1401, 0x1908, 0x8058): (28, 4),  # GL_UNSIGNED_BYTE, GL_RGBA, GL_RGBA8 -> R8G8B8A8_UNORM
    (0x1401, 0x1908, 0x8C43): (29, 4),  # GL_UNSIGNED_BYTE, GL_RGBA, GL_SRGB8_ALPHA8 -> R8G8B8A8_UNORM_SRGB
    (0x1403, 0x1903, 0x822A): (56, 2),  # GL_UNSIGNED_SHORT, GL_RED, GL_R16 -> R16_UNORM
    (0x140B, 0x1908, 0x881A): (10, 8),  # GL_HALF_FLOAT, GL_RGBA, GL_RGBA16F -> R16G16B16A16_FLOAT
}

# glInternalFormat of GL_COMPRESSED_RGBA_ASTC_4x4 .. 12x12, and their sRGB (SRGB8_ALPHA8) twins.
ASTC_RGBA_FORMATS = 0x93B0
ASTC_SRGB_FORMATS = 0x93D0
ASTC_BLOCK_SIZES = [(4, 4), (5, 4), (5, 5), (6, 5), (6, 6), (8, 5), (8, 6), (8, 8), (10, 5), (10, 6), (10, 8),
                    (10, 10), (12, 10), (12, 12)]
DXGI_R8G8B8A8_UNORM, DXGI_R8G8B8A8_UNORM_SRGB = 28, 29

# KTX 2 vkFormat of VK_FORMAT_ASTC_4x4_UNORM_BLOCK; the formats follow in ASTC_BLOCK_SIZES order, each
# UNORM then SRGB.
KTX2_ASTC_FORMATS = 157

# KTX 2 vkFormat -> DXGI_FORMAT, for 4-byte texels.
KTX2_FORMATS = {
    37: DXGI_R8G8B8A8_UNORM,       # VK_FORMAT_R8G8B8A8_UNORM
    43: DXGI_R8G8B8A8_UNORM_SRGB,  # VK_FORMAT_R8G8B8A8_SRGB
}

DDSD_CAPS, DDSD_HEIGHT, DDSD_WIDTH, DDSD_PITCH, DDSD_PIXELFORMAT, DDSD_MIPMAPCOUNT = 0x1, 0x2, 0x4, 0x8, 0x1000, 0x20000
DDSCAPS_COMPLEX, DDSCAPS_TEXTURE, DDSCAPS_MIPMAP = 0x8, 0x1000, 0x400000
DDSCAPS2_CUBEMAP_ALL_FACES = 0xFE00
DDPF_FOURCC = 0x4
DDS_DIMENSION_TEXTURE2D = 3
DDS_RESOURCE_MISC_TEXTURECUBE = 0x4


def read_ktx(path):
    with open(path, "rb") as f:
        data = f.read()
    if data[:12] == KTX2_IDENTIFIER:
        return read_ktx2(path, data)
    if data[:12] != KTX_IDENTIFIER:
        sys.exit(f"{path}: not a KTX file")
    (endianness, gl_type, _type_size, gl_format, gl_internal_format, _base_internal_format,
     width, height, depth, array_elements, faces, mip_levels, kv_bytes) = struct.unpack_from("<13I", data, 12)
    if endianness != 0x04030201:
        sys.exit(f"{path}: big-endian KTX files aren't supported")
    for srgb, first in ((False, ASTC_RGBA_FORMATS), (True, ASTC_SRGB_FORMATS)):
        if gl_type == 0 and first <= gl_internal_format < first + len(ASTC_BLOCK_SIZES):
            if depth > 1 or faces != 1 or array_elements > 1:
                sys.exit(f"{path}: only 2D ASTC textures are supported")
            block_width, block_height = ASTC_BLOCK_SIZES[gl_internal_format - first]
            offset = 64 + kv_bytes
            (image_size,) = struct.unpack_from("<I", data, offset)
            texels = astc.decode(data[offset + 4:offset + 4 + image_size], width, height, block_width, block_height, srgb)
            return (width, height, 1, False, 1, DXGI_R8G8B8A8_UNORM_SRGB if srgb else DXGI_R8G8B8A8_UNORM, 4,
                    [[texels]])
    key = (gl_type, gl_format, gl_internal_format)
    if key not in FORMATS:
        sys.exit(f"{path}: unsupported format (glType {gl_type:#x}, glFormat {gl_format:#x}, "
                 f"glInternalFormat {gl_internal_format:#x})")
    if depth > 1 or faces not in (1, 6) or (faces == 6 and array_elements > 1):
        sys.exit(f"{path}: only 2D textures, 2D texture arrays and cube maps are supported")
    dxgi_format, texel_size = FORMATS[key]
    cube = faces == 6
    # A cube map's faces are its layers (+X, -X, +Y, -Y, +Z, -Z in both formats).
    layers = 6 if cube else max(array_elements, 1)
    mip_levels = max(mip_levels, 1)

    # KTX 1 stores each mip level with all its array layers or faces; DDS stores each layer with all
    # its mips.
    images = [[None] * mip_levels for _ in range(layers)]
    offset = 64 + kv_bytes
    for mip in range(mip_levels):
        (image_size,) = struct.unpack_from("<I", data, offset)
        offset += 4
        mip_width = max(width >> mip, 1)
        mip_height = max(height >> mip, 1)
        row = mip_width * texel_size
        padded_row = (row + 3) & ~3
        layer_size = padded_row * mip_height
        # A (non-array) cube map's imageSize is that of one face; each face is padded to 4 bytes.
        expected_size = layer_size if cube else layer_size * layers
        if image_size != expected_size:
            sys.exit(f"{path}: mip {mip} has {image_size} bytes, expected {expected_size}")
        layer_stride = (layer_size + 3) & ~3 if cube else layer_size
        for layer in range(layers):
            start = offset + layer * layer_stride
            # Rows are padded to 4 bytes in KTX, packed in DDS.
            images[layer][mip] = b"".join(data[start + y * padded_row:start + y * padded_row + row]
                                          for y in range(mip_height))
        offset += layer_stride * layers if cube else (image_size + 3) & ~3
    return width, height, layers, cube, mip_levels, dxgi_format, texel_size, images


def read_ktx2(path, data):
    (vk_format, _type_size, width, height, depth, layers, faces, mip_levels,
     supercompression) = struct.unpack_from("<9I", data, 12)
    astc_format = vk_format - KTX2_ASTC_FORMATS
    if 0 <= astc_format < 2 * len(ASTC_BLOCK_SIZES):
        if supercompression != 0:
            sys.exit(f"{path}: supercompressed KTX 2 files aren't supported")
        if depth > 1 or layers > 1 or faces != 1:
            sys.exit(f"{path}: only 2D ASTC textures are supported")
        block_width, block_height = ASTC_BLOCK_SIZES[astc_format // 2]
        srgb = astc_format % 2 == 1
        # The level index (offset, size, uncompressed size per level, level 0 first) follows the
        # 80-byte header.
        offset, size, _ = struct.unpack_from("<3Q", data, 80)
        texels = astc.decode(data[offset:offset + size], width, height, block_width, block_height, srgb)
        return (width, height, 1, False, 1, DXGI_R8G8B8A8_UNORM_SRGB if srgb else DXGI_R8G8B8A8_UNORM, 4,
                [[texels]])
    if vk_format not in KTX2_FORMATS:
        sys.exit(f"{path}: unsupported KTX 2 format (vkFormat {vk_format})")
    if supercompression != 0:
        sys.exit(f"{path}: supercompressed KTX 2 files aren't supported")
    if depth > 1 or layers > 1 or faces != 1:
        sys.exit(f"{path}: only 2D KTX 2 textures are supported")
    mip_levels = max(mip_levels, 1)
    # The level index (offset, size, uncompressed size per level, level 0 first) follows the
    # 80-byte header; rows are packed.
    images = []
    for mip in range(mip_levels):
        offset, size, _ = struct.unpack_from("<3Q", data, 80 + 24 * mip)
        expected_size = max(width >> mip, 1) * max(height >> mip, 1) * 4
        if size != expected_size:
            sys.exit(f"{path}: mip {mip} has {size} bytes, expected {expected_size}")
        images.append(data[offset:offset + size])
    return width, height, 1, False, mip_levels, KTX2_FORMATS[vk_format], 4, [images]


def write_dds(path, width, height, layers, cube, mip_levels, dxgi_format, texel_size, images):
    flags = DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PITCH | DDSD_PIXELFORMAT
    caps = DDSCAPS_TEXTURE
    caps2 = 0
    if mip_levels > 1:
        flags |= DDSD_MIPMAPCOUNT
        caps |= DDSCAPS_COMPLEX | DDSCAPS_MIPMAP
    if cube:
        caps |= DDSCAPS_COMPLEX
        caps2 |= DDSCAPS2_CUBEMAP_ALL_FACES
    pixel_format = struct.pack("<II4s5I", 32, DDPF_FOURCC, b"DX10", 0, 0, 0, 0, 0)
    header = struct.pack("<7I", 124, flags, height, width, width * texel_size, 0, mip_levels)
    header += b"\0" * 44 + pixel_format + struct.pack("<5I", caps, caps2, 0, 0, 0)
    # A cube map's array size counts cubes, not faces.
    dx10 = struct.pack("<5I", dxgi_format, DDS_DIMENSION_TEXTURE2D, DDS_RESOURCE_MISC_TEXTURECUBE if cube else 0,
                       1 if cube else layers, 0)
    with open(path, "wb") as f:
        f.write(b"DDS " + header + dx10)
        for layer in images:
            for image in layer:
                f.write(image)


def convert(source, output):
    texture = read_ktx(source)
    os.makedirs(os.path.dirname(os.path.abspath(output)), exist_ok=True)
    write_dds(output, *texture)


def main():
    if len(sys.argv) < 3 or len(sys.argv) % 2 != 1:
        sys.exit(__doc__)
    pairs = list(zip(sys.argv[1::2], sys.argv[2::2]))
    if len(pairs) == 1:
        convert(*pairs[0])
        return
    with concurrent.futures.ProcessPoolExecutor() as executor:
        futures = [executor.submit(convert, source, output) for source, output in pairs]
        for future in futures:
            future.result()


if __name__ == "__main__":
    main()

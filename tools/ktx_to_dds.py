"""Converts uncompressed KTX 1 textures (as Vulkan-Samples ships them) to DDS, which Donut loads.

Donut's texture cache reads DDS, KTX 2 and the usual image formats, not KTX 1. This handles what the
ported samples need: RGBA8, R16 and RGBA16F data, 2D textures, 2D texture arrays and cube maps, with
their mip levels.

    python tools/ktx_to_dds.py <input.ktx> <output.dds>
"""

import os
import struct
import sys

KTX_IDENTIFIER = b"\xabKTX 11\xbb\r\n\x1a\n"

# (glType, glFormat, glInternalFormat) -> (DXGI_FORMAT, bytes per texel)
FORMATS = {
    (0x1401, 0x1908, 0x8058): (28, 4),  # GL_UNSIGNED_BYTE, GL_RGBA, GL_RGBA8 -> R8G8B8A8_UNORM
    (0x1403, 0x1903, 0x822A): (56, 2),  # GL_UNSIGNED_SHORT, GL_RED, GL_R16 -> R16_UNORM
    (0x140B, 0x1908, 0x881A): (10, 8),  # GL_HALF_FLOAT, GL_RGBA, GL_RGBA16F -> R16G16B16A16_FLOAT
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
    if data[:12] != KTX_IDENTIFIER:
        sys.exit(f"{path}: not a KTX 1 file")
    (endianness, gl_type, _type_size, gl_format, gl_internal_format, _base_internal_format,
     width, height, depth, array_elements, faces, mip_levels, kv_bytes) = struct.unpack_from("<13I", data, 12)
    if endianness != 0x04030201:
        sys.exit(f"{path}: big-endian KTX files aren't supported")
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


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    texture = read_ktx(sys.argv[1])
    os.makedirs(os.path.dirname(os.path.abspath(sys.argv[2])), exist_ok=True)
    write_dds(sys.argv[2], *texture)


if __name__ == "__main__":
    main()

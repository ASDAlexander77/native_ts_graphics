/// <reference path="../donut_handles.d.ts" />
/// <reference path="resources.d.ts" />
// FBC block compression of DDS images (core/fast_block_compress.cpp)

// Handles of the module's objects (see donut_handles.d.ts).
@cpp declare class FbcTextureHandle { private readonly __fbcTexture: index; }

// The Xbox ATG FastBlockCompress sample's CPU side (core/fast_block_compress.cpp with the sample's
// CPU compressor, core/fbc_cpu.cpp, linked only into the examples that list them). A DDS file in
// memory (square, a power of two, 32-bit BGRA / BGRX / RGBA) decoded to RGBA8 levels in the
// sample's CPU compressor layout (16-byte aligned, natural pitches, 2x2 and 1x1 replicated to 4x4;
// X8 alpha read as 255). Null on failure; free it with Donut_DestroyFbcTexture.
@nodrops declare function Donut_FbcDecodeDds(data: Ref<u8>, byteSize: int): FbcTextureHandle | null;
// The sample's CPU compression of such an image into BC1_UNORM, BC3_UNORM or BC5_UNORM: its top
// level alone, then every level; stats gets the milliseconds of each (Ref of a `let` f32 array of
// 2). Null on failure; free it with Donut_DestroyFbcTexture.
@nodrops declare function Donut_FbcCompressCpu(fbcTexture: FbcTextureHandle, format: Format, stats: Ref<f32>): FbcTextureHandle | null;
@nodrops declare function Donut_GetFbcTextureWidth(fbcTexture: FbcTextureHandle): int;
@nodrops declare function Donut_GetFbcTextureLevelCount(fbcTexture: FbcTextureHandle): int;
// A level's data, its rows (of pixels, or of 4x4 blocks) rowPitch bytes apart, valid until the
// texture is freed.
@nodrops declare function Donut_GetFbcTextureLevelData(fbcTexture: FbcTextureHandle, level: int): Opaque;
@nodrops declare function Donut_GetFbcTextureLevelRowPitch(fbcTexture: FbcTextureHandle, level: int): int;
@nodrops declare function Donut_DestroyFbcTexture(fbcTexture: FbcTextureHandle): void;

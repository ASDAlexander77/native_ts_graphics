/// <reference path="../donut_handles.d.ts" />
// KTX2/Basis Universal transcoding (core/basis_transcoder.cpp)

// Handles of the module's objects (see donut_handles.d.ts).
@cpp declare class TranscodedTextureHandle { private readonly __transcodedTexture: index; }

// Donut_TranscodeKtx2's target formats (core/basis_transcoder.cpp, linked into the examples that
// use it): RGBA8, BC7, BC3, ASTC 4x4, ETC2 RGBA.
enum TranscodeFormat {
    RGBA32 = 0,
    BC7 = 1,
    BC3 = 2,
    ASTC4x4 = 3,
    ETC2 = 4
}

// Basis Universal transcoding (core/basis_transcoder.cpp, linked only into the examples that list
// it): a KTX 2 file in memory (Basis Universal ETC1S or UASTC, Zstandard supercompressed or not)
// transcoded into format, every level, kept on the CPU; stats gets the milliseconds it took and
// the bytes (Ref of a `let` f32 array of 2). Null on failure; free it with
// Donut_DestroyTranscodedTexture.
@nodrops declare function Donut_TranscodeKtx2(data: Ref<u8>, byteSize: int, format: TranscodeFormat, stats: Ref<f32>): TranscodedTextureHandle | null;
@nodrops declare function Donut_GetTranscodedWidth(transcodedTexture: TranscodedTextureHandle): int;
@nodrops declare function Donut_GetTranscodedHeight(transcodedTexture: TranscodedTextureHandle): int;
@nodrops declare function Donut_GetTranscodedLevelCount(transcodedTexture: TranscodedTextureHandle): int;
// A level's data, block (or pixel) rows rowPitch bytes apart, valid until the texture is freed.
@nodrops declare function Donut_GetTranscodedLevelData(transcodedTexture: TranscodedTextureHandle, level: int): Opaque;
@nodrops declare function Donut_GetTranscodedLevelRowPitch(transcodedTexture: TranscodedTextureHandle, level: int): int;
@nodrops declare function Donut_DestroyTranscodedTexture(transcodedTexture: TranscodedTextureHandle): void;

/// <reference path="../donut_handles.d.ts" />
/// <reference path="resources.d.ts" />
// Opacity micromap baking with the OMM SDK (core/omm_bake.cpp)

// Handles of the module's objects (see donut_handles.d.ts).
@cpp declare class OmmBakerHandle extends ObjectHandle { private readonly __ommBaker: index; }

// Opacity micromaps baked at run time (core/omm_bake.cpp, linked only into the examples that list it):
// the GPU baker of NVIDIA's Opacity Micro-Map SDK (fetched at configure time, WITH_OMM_SDK, Windows)
// on the app's device (Donut_GetNvrhiDevice; D3D12 or Vulkan). Null without the SDK or on failure.
// Free it with Donut_DestroyOmmBaker before the app: it holds its bakes' buffers.
@nodrops declare function Donut_CreateOmmBaker(device: Opaque): OmmBakerHandle | null;
@nodrops declare function Donut_DestroyOmmBaker(ommBaker: OmmBakerHandle): void;
// Bakes one geometry's micromaps: alphaTexture's channel alphaChannel against alphaCutoff (above:
// opaque) at the texture coordinates (two floats each) of texCoordBuffer (a raw view buffer), indexed
// by indexCount 32-bit indices of indexBuffer from its index indexOffset (an OMM index per triangle,
// in that order). maxSubdivisionLevel 1-12; use4State: 4-state OMMs, else 2-state;
// dynamicSubdivisionScale: the SDK's (0: every OMM at maxSubdivisionLevel). Waits for the GPU.
// Returns the bake's index for the getters, or -1 on failure.
@nodrops declare function Donut_OmmBakerBake(ommBaker: OmmBakerHandle, alphaTexture: TextureHandle, alphaChannel: int,
    alphaCutoff: number, texCoordBuffer: BufferHandle, indexBuffer: BufferHandle, indexOffset: int, indexCount: int,
    maxSubdivisionLevel: int, use4State: boolean, dynamicSubdivisionScale: number): int;
// A bake's array data, descs and OMM indices (acceleration structure build inputs; the baker's: don't
// release them), and the indices' format (R16_UINT or R32_UINT) and count.
@nodrops declare function Donut_GetOmmBakerArrayBuffer(ommBaker: OmmBakerHandle, bake: int): BufferHandle;
@nodrops declare function Donut_GetOmmBakerDescBuffer(ommBaker: OmmBakerHandle, bake: int): BufferHandle;
@nodrops declare function Donut_GetOmmBakerIndexBuffer(ommBaker: OmmBakerHandle, bake: int): BufferHandle;
@nodrops declare function Donut_GetOmmBakerIndexFormat(ommBaker: OmmBakerHandle, bake: int): Format;
@nodrops declare function Donut_GetOmmBakerIndexCount(ommBaker: OmmBakerHandle, bake: int): int;
// A bake's histograms: up to maxEntries entries of three ints (count, subdivision level, format)
// into dst; returns the entries there are. The array's is what Donut_CreateOpacityMicromap takes,
// the indices' Donut_SetTriangleBlasGeometryOpacityMicromap.
@nodrops declare function Donut_GetOmmBakerArrayHistogram(ommBaker: OmmBakerHandle, bake: int, dst: Ref<int>, maxEntries: int): int;
@nodrops declare function Donut_GetOmmBakerIndexHistogram(ommBaker: OmmBakerHandle, bake: int, dst: Ref<int>, maxEntries: int): int;
// A bake's stats, 0-7: the array's and descs' sizes (bytes), the micro-triangles opaque, transparent
// and unknown, the OMMs fully opaque, transparent and unknown.
@nodrops declare function Donut_GetOmmBakerStat(ommBaker: OmmBakerHandle, bake: int, stat: int): int;

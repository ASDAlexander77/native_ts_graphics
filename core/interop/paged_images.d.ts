/// <reference path="../donut_handles.d.ts" />
// Images streamed into video memory a mip level at a time (core/paged_images.cpp)

// Handles of the module's objects (see donut_handles.d.ts).
@cpp declare class PagedImageSetHandle extends ObjectHandle { private readonly __pagedImageSet: index; }

// Images streamed into video memory a mip level at a time under the memory budget
// (core/paged_images.cpp, linked only into the examples that list it; D3D12):
// DirectX-Graphics-Samples' D3D12MemoryManagement's paging: reserved textures, each level backed by
// heaps of its own, mapped and filled on a copy queue by a paging thread, made resident again or
// evicted by the images' priorities under the DXGI budget. Free it with Donut_DestroyPagedImageSet
// before the app.
@nodrops declare function Donut_CreatePagedImageSet(): PagedImageSetHandle;
@nodrops declare function Donut_DestroyPagedImageSet(pagedImageSet: PagedImageSetHandle): void;
// Starts the paging thread and creates the images: a DDS file's (BC1 or RGBA8 with its levels;
// empty path: none) then generatedCount 4096 x 4096 checkerboards of 13 levels. device: the app's
// (Donut_GetNvrhiDevice), D3D12 with tiled resources. Returns 0 on failure.
@nodrops declare function Donut_InitPagedImageSet(pagedImageSet: PagedImageSetHandle, device: Opaque, ddsPath: string,
    generatedCount: int): int;
@nodrops declare function Donut_GetPagedImageCount(pagedImageSet: PagedImageSetHandle): int;
// An image's size, level count and texture (NVRHI's handle, the set's: don't release it).
@nodrops declare function Donut_GetPagedImageWidth(pagedImageSet: PagedImageSetHandle, image: int): int;
@nodrops declare function Donut_GetPagedImageHeight(pagedImageSet: PagedImageSetHandle, image: int): int;
@nodrops declare function Donut_GetPagedImageMipCount(pagedImageSet: PagedImageSetHandle, image: int): int;
@nodrops declare function Donut_GetPagedImageTexture(pagedImageSet: PagedImageSetHandle, image: int): TextureHandle;
// The most detailed level resident (the level count: none yet).
@nodrops declare function Donut_GetPagedImageResidentMip(pagedImageSet: PagedImageSetHandle, image: int): int;
// Starts a render frame (marks the previous frame's commands on the graphics queue).
@nodrops declare function Donut_BeginPagedImageFrame(pagedImageSet: PagedImageSetHandle): void;
// An image's visible level and level to prefetch (15: none); the paging thread reprioritizes it
// when they change.
@nodrops declare function Donut_SetPagedImageMips(pagedImageSet: PagedImageSetHandle, image: int, visibleMip: int, prefetchMip: int): void;
// The level this frame draws an image from for the requested one (no more detailed than resident
// or trimming allows), kept resident until the GPU has finished the frame.
@nodrops declare function Donut_ReferencePagedImage(pagedImageSet: PagedImageSetHandle, image: int, requestedMip: int): int;
// Local video memory usage and budget (bytes; the override applied), as the paging thread last
// saw them.
@nodrops declare function Donut_GetPagedImageSetUsage(pagedImageSet: PagedImageSetHandle): number;
@nodrops declare function Donut_GetPagedImageSetBudget(pagedImageSet: PagedImageSetHandle): number;
// The budget to keep to instead of the kernel's (bytes; 0: the kernel's).
@nodrops declare function Donut_SetPagedImageSetBudgetOverride(pagedImageSet: PagedImageSetHandle, bytes: number): void;
@nodrops declare function Donut_GetPagedImageSetBudgetOverride(pagedImageSet: PagedImageSetHandle): number;
// Waits up to timeoutMs for the paging thread to run out of work (or to wait for frames);
// 1 if it did.
@nodrops declare function Donut_WaitForPagedImagesIdle(pagedImageSet: PagedImageSetHandle, timeoutMs: int): int;

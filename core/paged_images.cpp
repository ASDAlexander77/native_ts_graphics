// Images streamed into video memory a mip level at a time under the process's memory budget, for
// TypeScript (the examples that list it link it; see CMakeLists.txt): DirectX-Graphics-Samples'
// D3D12MemoryManagement's framework (its Framework.cpp, Paging.cpp), on D3D12 only. Each image is a
// reserved (tiled) texture whose standard mip levels are each backed by heaps of their own (16 MB
// at most each) and its packed mips by one more; a paging thread maps and fills the levels on a copy
// queue of its own, makes them resident again (MakeResident) or evicts them (Evict) by the images'
// priorities (the mips they show and the ones near the camera need), keeping the process's local
// video memory usage under its DXGI budget (or an override of it). The render thread draws each
// image from its most detailed resident level it may use (Donut_ReferencePagedImage), which the
// paging thread won't evict until the GPU has finished that frame.
//
// The images: a DDS file's (a block-compressed or 8-bit RGBA texture with all its levels), and
// checkerboards generated at 4096 x 4096 with 13 levels, each in its own color, as the sample's.
// The textures are created in the COMMON state and never transitioned: the copy queue's writes and
// the graphics queue's reads promote the levels they touch implicitly (and they decay back), each
// queue touching levels the other doesn't, which NVRHI is told nothing about (the handles it gets
// are in a ShaderResource state it keeps).
//
// Copyright (c) Microsoft. All rights reserved.
// This code is licensed under the MIT License (MIT).

#include <nvrhi/nvrhi.h>

#ifdef _WIN32
#include <d3d12.h>
#include <dxgi1_4.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <list>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "donut_api.h"

using Microsoft::WRL::ComPtr;

namespace
{
    constexpr UINT64 TILE_SIZE = 64 * 1024;
    constexpr UINT64 MAX_HEAP_SIZE = 16 * 1024 * 1024;
    constexpr int MAX_MIP_COUNT = 16;
    constexpr uint8_t UNDEFINED_MIPMAP_INDEX = MAX_MIP_COUNT - 1;
    constexpr UINT64 MB = 1024 * 1024;

    // The worker thread processes the resources in these queues in strict order.
    enum ResourcePriority
    {
        ERP_VeryHigh,
        ERP_High,
        ERP_Medium,
        ERP_Low,
        _ERP_COUNT
    };

    // How far trimming may go to make room for a resource's paging: lower priority resources
    // can't trim higher priority ones.
    enum ResourceTrimPass
    {
        ERTP_None,
        ERTP_NonPrefetchable,
        ERTP_NonVisible,
        ERTP_Visible,
    };

    // The generated images' colors (0xAABBGGRR).
    const uint32_t g_GeneratedImageColors[] = {
        0xff0000ff, // Red
        0xff0088ff, // Orange
        0xff00ffff, // Yellow
        0xff009900, // Green
        0xffffff00, // Cyan
        0xffff0000, // Blue
        0xffff00ff, // Magenta
        0xff000000, // Black
    };

    // One mip heap of an image: a standard mip level, or all its packed ones (the last).
    struct ResourceMip
    {
        UINT widthInTiles = 0;
        UINT heightInTiles = 0;
        UINT numTiles = 0;
        std::vector<ComPtr<ID3D12Heap>> heaps;
        // The last frame (the render fence's value) that drew from this mip.
        uint64_t referenceFence = 0;
    };

    struct PagedImage
    {
        // The source: a DDS file's contents and its levels' offsets, or a generated image.
        int generatedImageIndex = -1;
        std::vector<uint8_t> file;
        std::vector<size_t> levelOffsets;
        DXGI_FORMAT format = DXGI_FORMAT_UNKNOWN;
        UINT width = 0;
        UINT height = 0;
        UINT mipCount = 0;

        ComPtr<ID3D12Resource> resource;
        nvrhi::TextureHandle texture;
        std::vector<ResourceMip> mips;
        UINT packedMipTileCount = 0;
        uint8_t numStandardMips = 0; // also the packed mips' heap index
        uint8_t numPackedMips = 0;

        // The most detailed mip level resident (the mip count: none), the most detailed one
        // rendering may use while trimming prepares to evict, the one visible on screen and the one
        // to prefetch (UNDEFINED_MIPMAP_INDEX: none).
        std::atomic<uint8_t> mostDetailedMipResident{ 0 };
        std::atomic<uint8_t> mipRestriction{ 0 };
        std::atomic<uint8_t> visibleMip{ UNDEFINED_MIPMAP_INDEX };
        std::atomic<uint8_t> prefetchMip{ UNDEFINED_MIPMAP_INDEX };
        bool ignoreBudget = false;
        ResourceTrimPass trimLimit = ERTP_None;
        std::mutex referenceLock;

        // List membership: the prioritization list, a priority queue, a commitment list (by
        // most detailed resident mip; -1: uncommitted).
        bool inPrioritizationList = false;
        int pagingQueue = -1;
        std::list<PagedImage*>::iterator pagingEntry;
        int commitmentList = -1;
        std::list<PagedImage*>::iterator commitmentEntry;

        uint8_t MipCount() const { return uint8_t(numStandardMips + numPackedMips); }
        uint8_t PackedMipHeapIndex() const { return numStandardMips; }
        uint8_t LeastDetailedMipHeapIndex() const { return numPackedMips != 0 ? numStandardMips : uint8_t(numStandardMips - 1); }
        uint8_t MipHeapIndex(uint8_t mip) const { return std::min(mip, PackedMipHeapIndex()); }
        UINT MipHeapCount(const ResourceMip& m) const
        {
            return UINT((UINT64(m.widthInTiles) * m.heightInTiles * TILE_SIZE + MAX_HEAP_SIZE - 1) / MAX_HEAP_SIZE);
        }
        UINT64 NonPackedMipSize(UINT mipHeapIndex) const
        {
            return UINT64(mips[mipHeapIndex].widthInTiles) * mips[mipHeapIndex].heightInTiles * TILE_SIZE;
        }
    };

    inline bool IsLessDetailedMip(uint8_t currentMip, uint8_t mipToCheck) { return mipToCheck > currentMip; }
    inline bool IsMoreDetailedMip(uint8_t currentMip, uint8_t mipToCheck) { return mipToCheck < currentMip; }
    inline uint8_t IncreaseMipQuality(uint8_t mip, uint8_t by) { return by > mip ? 0 : uint8_t(mip - by); }
    inline uint8_t DecreaseMipQuality(uint8_t mip, uint8_t by) { return uint8_t(mip + by); }
}

// The set of images and the paging machinery (Donut_CreatePagedImageSet).
struct PagedImageSet
{
    nvrhi::DeviceHandle nvrhiDevice;
    ComPtr<ID3D12Device> device;
    ComPtr<ID3D12CommandQueue> graphicsQueue;
    ComPtr<IDXGIAdapter3> adapter;
    std::vector<std::unique_ptr<PagedImage>> images;

    // The paging context: a copy queue (the GPU's paging engines) and what it records with.
    ComPtr<ID3D12CommandQueue> copyQueue;
    ComPtr<ID3D12CommandAllocator> copyAllocator;
    ComPtr<ID3D12GraphicsCommandList> copyList;
    ComPtr<ID3D12Fence> copyFence;
    uint64_t copyFenceValue = 0;
    HANDLE copyEvent = nullptr;

    // The render frames: a fence signaled on the graphics queue with each frame's number once its
    // commands are submitted (Donut_BeginPagedImageFrame signals the previous one).
    ComPtr<ID3D12Fence> renderFence;
    uint64_t frameNumber = 0;
    HANDLE renderEvent = nullptr;

    // Local video memory: usage and budget (the override applied), as the paging thread last saw.
    std::atomic<uint64_t> localUsage{ 0 };
    std::atomic<uint64_t> localBudget{ 0 };
    std::atomic<uint64_t> localBudgetOverride{ 0 };

    // Commitment lists, by most detailed resident mip.
    std::list<PagedImage*> uncommitted;
    std::list<PagedImage*> commitmentLists[MAX_MIP_COUNT];

    // The worker thread.
    std::thread thread;
    HANDLE wakeSubmission = nullptr;
    HANDLE wakeBudget = nullptr;
    HANDLE shutdown = nullptr;
    DWORD budgetCookie = 0;
    bool budgetRegistered = false;
    std::mutex prioritizationLock;
    std::list<PagedImage*> prioritizationList;
    std::list<PagedImage*> priorityQueues[_ERP_COUNT];

    // Idle tracking for Donut_WaitForPagedImagesIdle: submissions made, the count the worker had
    // seen when it last ran out of work, whether it's waiting for a frame to finish.
    std::atomic<uint64_t> submissions{ 0 };
    std::mutex idleMutex;
    std::condition_variable idleChanged;
    bool idle = false;
    uint64_t idleSubmissions = 0;
    bool waitingForFrame = false;

    // --- Video memory --------------------------------------------------------------------------

    void UpdateVideoMemoryInfo()
    {
        DXGI_QUERY_VIDEO_MEMORY_INFO local{};
        if (FAILED(adapter->QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &local)))
            return;
        const uint64_t budgetOverride = localBudgetOverride;
        if (budgetOverride != 0)
            local.Budget = budgetOverride;
        localUsage = local.CurrentUsage;
        localBudget = local.Budget;
    }

    bool IsOverBudget() const { return localUsage > localBudget; }
    bool IsWithinBudgetThreshold(UINT64 size) const { return localUsage + size <= localBudget; }

    // --- Render frames -------------------------------------------------------------------------

    uint64_t LastCompletedFrame() const { return renderFence->GetCompletedValue(); }

    // Waits for the render thread's frame to finish on the GPU (false if shutting down first).
    bool WaitForFrame(uint64_t value)
    {
        if (renderFence->GetCompletedValue() >= value)
            return true;
        {
            std::lock_guard<std::mutex> lock(idleMutex);
            waitingForFrame = true;
        }
        idleChanged.notify_all();
        renderFence->SetEventOnCompletion(value, renderEvent);
        HANDLE handles[2] = { renderEvent, shutdown };
        const DWORD result = WaitForMultipleObjects(2, handles, FALSE, INFINITE);
        {
            std::lock_guard<std::mutex> lock(idleMutex);
            waitingForFrame = false;
        }
        return result == WAIT_OBJECT_0;
    }

    // --- Commitment ----------------------------------------------------------------------------

    void RemoveCommitment(PagedImage* r)
    {
        if (r->commitmentList < 0)
            uncommitted.remove(r);
        else
            commitmentLists[r->commitmentList].erase(r->commitmentEntry);
        r->commitmentList = -2;
    }

    void AddResourceCommitment(PagedImage* r)
    {
        RemoveCommitment(r);
        const int index = r->mostDetailedMipResident;
        r->commitmentEntry = commitmentLists[index].insert(commitmentLists[index].end(), r);
        r->commitmentList = index;
    }

    // --- Paging --------------------------------------------------------------------------------

    void FillGeneratedMip(int imageIndex, UINT width, UINT height, UINT rowPitch, uint8_t* dst)
    {
        // GenerateMip: an 8 x 8 checkerboard of the image's color and a gray with a subtle
        // gradient from the top left corner to the bottom right.
        const UINT cellWidth = std::max(width >> 3, 1u);
        const UINT cellHeight = std::max(height >> 3, 1u);
        const uint8_t gray = 0x88;
        const uint32_t color = g_GeneratedImageColors[imageIndex % 8];
        for (UINT y = 0; y < height; y++)
        {
            uint32_t* row = reinterpret_cast<uint32_t*>(dst + size_t(y) * rowPitch);
            const UINT j = y / cellHeight;
            for (UINT x = 0; x < width; x++)
            {
                const UINT i = x / cellWidth;
                if (i % 2 == j % 2)
                {
                    row[x] = color;
                }
                else
                {
                    const uint8_t shade = uint8_t(uint8_t((i + j) << 3) + gray);
                    row[x] = 0xffu << 24 | uint32_t(shade) << 16 | uint32_t(shade) << 8 | shade;
                }
            }
        }
    }

    bool ExecuteCopyAndWait()
    {
        if (FAILED(copyList->Close()))
            return false;
        ID3D12CommandList* lists[] = { copyList.Get() };
        copyQueue->ExecuteCommandLists(1, lists);
        copyQueue->Signal(copyFence.Get(), ++copyFenceValue);
        if (copyFence->GetCompletedValue() < copyFenceValue)
        {
            copyFence->SetEventOnCompletion(copyFenceValue, copyEvent);
            WaitForSingleObject(copyEvent, INFINITE);
        }
        copyAllocator->Reset();
        copyList->Reset(copyAllocator.Get(), nullptr);
        return true;
    }

    // LoadMip: the heaps of a mip level (created if missing), its tiles mapped to them, and its
    // contents uploaded, on the copy queue; then it's the most detailed level resident.
    bool LoadMip(PagedImage* r, uint8_t mip)
    {
        uint8_t mipHeap = mip;
        UINT numTiles;
        UINT widthInTiles;
        if (mipHeap >= r->PackedMipHeapIndex())
        {
            mipHeap = r->PackedMipHeapIndex();
            widthInTiles = r->packedMipTileCount;
            numTiles = r->packedMipTileCount;
        }
        else
        {
            widthInTiles = r->mips[mipHeap].widthInTiles;
            numTiles = widthInTiles * r->mips[mipHeap].heightInTiles;
        }

        ResourceMip& m = r->mips[mipHeap];
        const UINT numHeapsInMip = UINT((numTiles * TILE_SIZE + MAX_HEAP_SIZE - 1) / MAX_HEAP_SIZE);
        UINT64 remainingSize = numTiles * TILE_SIZE;
        if (m.heaps.size() < numHeapsInMip)
            m.heaps.resize(numHeapsInMip);
        for (UINT i = 0; i < numHeapsInMip; ++i)
        {
            if (!m.heaps[i])
            {
                D3D12_HEAP_DESC heapDesc = {};
                heapDesc.SizeInBytes = std::min(remainingSize, MAX_HEAP_SIZE);
                heapDesc.Properties.Type = D3D12_HEAP_TYPE_DEFAULT;
                heapDesc.Flags = D3D12_HEAP_FLAG_DENY_RT_DS_TEXTURES | D3D12_HEAP_FLAG_DENY_BUFFERS;
                if (FAILED(device->CreateHeap(&heapDesc, IID_PPV_ARGS(&m.heaps[i]))))
                {
                    fprintf(stderr, "Failed to create a D3D12 heap\n");
                    return false;
                }
                remainingSize -= heapDesc.SizeInBytes;
            }
        }

        // The upload buffer.
        const D3D12_RESOURCE_DESC desc = r->resource->GetDesc();
        D3D12_PLACED_SUBRESOURCE_FOOTPRINT layout;
        UINT numRows;
        UINT64 rowSizeInBytes;
        UINT64 totalBytes;
        device->GetCopyableFootprints(&desc, mip, 1, 0, &layout, &numRows, &rowSizeInBytes, &totalBytes);
        D3D12_HEAP_PROPERTIES uploadHeap = {};
        uploadHeap.Type = D3D12_HEAP_TYPE_UPLOAD;
        D3D12_RESOURCE_DESC bufferDesc = {};
        bufferDesc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
        bufferDesc.Width = totalBytes;
        bufferDesc.Height = 1;
        bufferDesc.DepthOrArraySize = 1;
        bufferDesc.MipLevels = 1;
        bufferDesc.SampleDesc.Count = 1;
        bufferDesc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
        ComPtr<ID3D12Resource> uploadBuffer;
        if (FAILED(device->CreateCommittedResource(&uploadHeap, D3D12_HEAP_FLAG_NONE, &bufferDesc,
                D3D12_RESOURCE_STATE_GENERIC_READ, nullptr, IID_PPV_ARGS(&uploadBuffer))))
        {
            fprintf(stderr, "Failed to create an upload buffer\n");
            return false;
        }
        uint8_t* uploadData = nullptr;
        D3D12_RANGE readRange = { 0, 0 };
        if (FAILED(uploadBuffer->Map(0, &readRange, reinterpret_cast<void**>(&uploadData))))
            return false;

        // The tiles, mapped a heap at a time.
        {
            const UINT maxTilesPerUpdate = UINT(MAX_HEAP_SIZE / TILE_SIZE);
            UINT numTilesRemaining = numTiles;
            UINT heapIndex = 0;
            while (numTilesRemaining)
            {
                const UINT tilesInUpdate = std::min(maxTilesPerUpdate, numTilesRemaining);
                const UINT tileOffset = numTiles - numTilesRemaining;
                // Packed mips are one range of tiles, which starts at the first packed mip's
                // subresource (the sample passes the level's own, which the debug layer rejects).
                D3D12_TILED_RESOURCE_COORDINATE coordinates = {};
                coordinates.Subresource = std::min(mip, r->PackedMipHeapIndex());
                coordinates.X = tileOffset % widthInTiles;
                coordinates.Y = tileOffset / widthInTiles;
                D3D12_TILE_REGION_SIZE regionSize = {};
                regionSize.NumTiles = tilesInUpdate;
                D3D12_TILE_RANGE_FLAGS rangeFlags = D3D12_TILE_RANGE_FLAG_NONE;
                UINT rangeOffset = 0;
                UINT rangeCount = tilesInUpdate;
                copyQueue->UpdateTileMappings(r->resource.Get(), 1, &coordinates, &regionSize, m.heaps[heapIndex].Get(), 1,
                    &rangeFlags, &rangeOffset, &rangeCount, D3D12_TILE_MAPPING_FLAG_NO_HAZARD);
                numTilesRemaining -= tilesInUpdate;
                ++heapIndex;
            }
        }

        // The contents: the file's level, or the generated one.
        const UINT mipWidth = std::max(r->width >> mip, 1u);
        const UINT mipHeight = std::max(r->height >> mip, 1u);
        if (r->generatedImageIndex >= 0)
        {
            FillGeneratedMip(r->generatedImageIndex, mipWidth, mipHeight, layout.Footprint.RowPitch, uploadData + layout.Offset);
        }
        else
        {
            const uint8_t* src = r->file.data() + r->levelOffsets[mip];
            for (UINT row = 0; row < numRows; row++)
                memcpy(uploadData + layout.Offset + size_t(row) * layout.Footprint.RowPitch, src + size_t(row) * rowSizeInBytes,
                    size_t(rowSizeInBytes));
        }
        uploadBuffer->Unmap(0, nullptr);

        D3D12_TEXTURE_COPY_LOCATION dst = {};
        dst.pResource = r->resource.Get();
        dst.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
        dst.SubresourceIndex = mip;
        D3D12_TEXTURE_COPY_LOCATION src = {};
        src.pResource = uploadBuffer.Get();
        src.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
        src.PlacedFootprint = layout;
        copyList->CopyTextureRegion(&dst, 0, 0, 0, &src, nullptr);
        if (!ExecuteCopyAndWait())
            return false;

        r->mostDetailedMipResident = mip;
        AddResourceCommitment(r);
        return true;
    }

    // PageInNextLevelOfDetail: the next more detailed level, made resident again if its heaps
    // were evicted, else loaded.
    bool PageInNextLevelOfDetail(PagedImage* r)
    {
        const uint8_t residentMip = r->mostDetailedMipResident;
        const uint8_t mip = uint8_t(residentMip - 1);
        const uint8_t mipHeap = r->MipHeapIndex(mip);
        ResourceMip& m = r->mips[mipHeap];
        if (m.heaps.empty() || !m.heaps[0] || mip >= r->PackedMipHeapIndex())
            return LoadMip(r, mip);

        const UINT heapCount = r->MipHeapCount(m);
        UINT i;
        HRESULT hr = S_OK;
        for (i = 0; i < heapCount; ++i)
        {
            ID3D12Pageable* pageable = m.heaps[i].Get();
            hr = device->MakeResident(1, &pageable);
            if (FAILED(hr))
            {
                fprintf(stderr, "Failed to make mip %d resident\n", mip);
                break;
            }
        }
        if (FAILED(hr))
        {
            while (i > 0)
            {
                ID3D12Pageable* pageable = m.heaps[i].Get();
                device->Evict(1, &pageable);
                --i;
            }
            return false;
        }
        r->mostDetailedMipResident = mip;
        r->mipRestriction = 0;
        AddResourceCommitment(r);
        return true;
    }

    // TrimMip: a level's heaps evicted; the next less detailed level is the most detailed one
    // resident.
    void TrimMip(PagedImage* r, uint8_t mip)
    {
        ResourceMip& m = r->mips[mip];
        const UINT heapCount = r->MipHeapCount(m);
        for (UINT i = 0; i < heapCount; ++i)
        {
            ID3D12Pageable* pageable = m.heaps[i].Get();
            if (FAILED(device->Evict(1, &pageable)))
                fprintf(stderr, "Failed to evict mip %d\n", mip);
        }
        r->mostDetailedMipResident = DecreaseMipQuality(mip, 1);
        r->mipRestriction = 0;
        AddResourceCommitment(r);
        PrioritizeResource(r);
    }

    // TrimToTarget: evicts the most detailed levels, least detailed lists first, in passes of
    // increasing reach (levels no one prefetches, then no one sees, then visible ones), until the
    // usage is under target. Levels the render thread drew from are evicted once the GPU is done
    // with that frame; rendering is restricted from them first.
    bool TrimToTarget(ResourceTrimPass maxPass, UINT64 targetUsage)
    {
        for (int pass = ERTP_NonPrefetchable; pass <= maxPass; ++pass)
        {
            for (int mip = 0; mip < MAX_MIP_COUNT; ++mip)
            {
                std::list<PagedImage*>& list = commitmentLists[mip];
                for (auto it = list.begin(); it != list.end();)
                {
                    PagedImage* r = *it;
                    ++it;
                    if (mip >= r->LeastDetailedMipHeapIndex())
                        continue;
                    ResourceMip& m = r->mips[mip];
                    uint64_t waitFence = 0;
                    {
                        std::lock_guard<std::mutex> lock(r->referenceLock);
                        if (m.referenceFence > LastCompletedFrame())
                            waitFence = m.referenceFence;
                        if (pass == ERTP_Visible)
                            r->mipRestriction = DecreaseMipQuality(uint8_t(mip), 1);
                        else if (pass == ERTP_NonVisible && IsLessDetailedMip(uint8_t(mip), r->visibleMip))
                            r->mipRestriction = DecreaseMipQuality(uint8_t(mip), 1);
                        else if (pass == ERTP_NonPrefetchable && IsLessDetailedMip(uint8_t(mip), r->prefetchMip))
                            r->mipRestriction = DecreaseMipQuality(uint8_t(mip), 1);
                    }
                    if (r->mipRestriction > mip)
                    {
                        if (waitFence > 0 && !WaitForFrame(waitFence))
                            return false;
                        TrimMip(r, uint8_t(mip));
                        UpdateVideoMemoryInfo();
                        if (localUsage < targetUsage)
                            return true;
                    }
                }
            }
        }
        return false;
    }

    bool TrimToBudget(ResourceTrimPass trimLimit) { return TrimToTarget(trimLimit, localBudget); }

    // --- The worker thread's queues ------------------------------------------------------------

    void EnqueueResource(PagedImage* r)
    {
        {
            std::lock_guard<std::mutex> lock(prioritizationLock);
            if (r->inPrioritizationList)
                prioritizationList.remove(r);
            prioritizationList.push_back(r);
            r->inPrioritizationList = true;
        }
        ++submissions;
        SetEvent(wakeSubmission);
    }

    void ReprioritizeResources()
    {
        std::lock_guard<std::mutex> lock(prioritizationLock);
        while (!prioritizationList.empty())
        {
            PagedImage* r = prioritizationList.front();
            prioritizationList.pop_front();
            r->inPrioritizationList = false;
            PrioritizeResource(r);
        }
    }

    void RemoveFromPagingQueue(PagedImage* r)
    {
        if (r->pagingQueue >= 0)
        {
            priorityQueues[r->pagingQueue].erase(r->pagingEntry);
            r->pagingQueue = -1;
        }
    }

    void InsertPaging(PagedImage* r, int queue, bool atHead)
    {
        auto& q = priorityQueues[queue];
        r->pagingEntry = atHead ? q.insert(q.begin(), r) : q.insert(q.end(), r);
        r->pagingQueue = queue;
    }

    // PrioritizeResource: the queue a resource's next level goes into. Very high: packed mips
    // missing near the camera (regardless of the budget); high: a more detailed level needed on
    // screen; medium: packed mips missing (regardless of the budget, ahead of the others) or a more
    // detailed level to prefetch; low: any more detailed level.
    void PrioritizeResource(PagedImage* r)
    {
        const uint8_t mostDetailedMipResident = r->mostDetailedMipResident;
        const uint8_t visibleMip = r->visibleMip;
        const uint8_t prefetchMip = r->prefetchMip;
        RemoveFromPagingQueue(r);
        const bool anyPackedMipsMissing = mostDetailedMipResident > r->LeastDetailedMipHeapIndex();
        const bool isInPrefetchZone = prefetchMip != UNDEFINED_MIPMAP_INDEX;
        if (anyPackedMipsMissing && isInPrefetchZone)
        {
            InsertPaging(r, ERP_VeryHigh, false);
            r->trimLimit = ERTP_Visible;
            r->ignoreBudget = true;
        }
        else if (IsMoreDetailedMip(mostDetailedMipResident, visibleMip))
        {
            InsertPaging(r, ERP_High, false);
            r->trimLimit = ERTP_NonVisible;
        }
        else if (anyPackedMipsMissing)
        {
            InsertPaging(r, ERP_Medium, true);
            r->trimLimit = ERTP_Visible;
            r->ignoreBudget = true;
        }
        else if (IsMoreDetailedMip(mostDetailedMipResident, prefetchMip))
        {
            InsertPaging(r, ERP_Medium, false);
            r->trimLimit = ERTP_NonPrefetchable;
        }
        else if (mostDetailedMipResident != 0)
        {
            InsertPaging(r, ERP_Low, false);
            r->trimLimit = ERTP_None;
        }
    }

    // SelectResource: the first resource of the highest priority queue whose next level fits in
    // the budget (with a bias growing with lower priorities), trimming lower priority levels to
    // make room.
    PagedImage* SelectResource()
    {
        for (int i = 0; i < _ERP_COUNT; ++i)
        {
            const UINT64 budgetBias = 1 * MB + 8 * MB * UINT64(i);
            if (priorityQueues[i].empty())
                continue;
            PagedImage* r = priorityQueues[i].front();
            const uint8_t nextMip = IncreaseMipQuality(r->mostDetailedMipResident, 1);
            UINT64 mipSize = 0;
            if (nextMip < r->PackedMipHeapIndex())
                mipSize = r->NonPackedMipSize(nextMip);
            if (!r->ignoreBudget)
            {
                // (Clamped: the sample's subtraction underflows under small budget overrides.)
                const UINT64 budget = localBudget;
                const UINT64 targetUsage = budget > mipSize + budgetBias ? budget - (mipSize + budgetBias) : 0;
                if (!IsWithinBudgetThreshold(mipSize + budgetBias))
                {
                    if (!TrimToTarget(r->trimLimit, targetUsage))
                        continue;
                }
            }
            RemoveFromPagingQueue(r);
            r->ignoreBudget = false;
            return r;
        }
        return nullptr;
    }

    void ProcessSubmission(bool* moreWork)
    {
        *moreWork = true;
        PagedImage* r = SelectResource();
        if (!r)
        {
            *moreWork = false;
            return;
        }
        if (!PageInNextLevelOfDetail(r))
            *moreWork = false;
        PrioritizeResource(r);
        UpdateVideoMemoryInfo();
        if (IsOverBudget())
            TrimToBudget(r->trimLimit);
    }

    void ProcessBudgetChangeNotification()
    {
        UpdateVideoMemoryInfo();
        if (localUsage > localBudget)
            TrimToBudget(ERTP_Visible);
    }

    void SetIdle(bool value)
    {
        {
            std::lock_guard<std::mutex> lock(idleMutex);
            idle = value;
            if (value)
                idleSubmissions = submissionsSeen;
        }
        idleChanged.notify_all();
    }
    uint64_t submissionsSeen = 0;

    void Run()
    {
        bool moreWork = false;
        for (;;)
        {
            if (!moreWork)
            {
                submissionsSeen = submissions;
                SetIdle(true);
            }
            HANDLE handles[3] = { shutdown, wakeSubmission, wakeBudget };
            const DWORD result = WaitForMultipleObjects(3, handles, FALSE, moreWork ? 0 : INFINITE);
            if (result == WAIT_OBJECT_0)
                break;
            if (result == WAIT_OBJECT_0 + 1)
            {
                SetIdle(false);
                moreWork = true;
            }
            else if (result == WAIT_OBJECT_0 + 2)
            {
                SetIdle(false);
                ProcessBudgetChangeNotification();
                moreWork = true;
            }
            if (moreWork)
            {
                ReprioritizeResources();
                ProcessSubmission(&moreWork);
            }
        }
        SetIdle(true);
    }

    // --- Creation --------------------------------------------------------------------------------

    // CreateResourceDeviceState: the reserved texture, its tiling, its mip heap slots.
    bool CreateResource(std::unique_ptr<PagedImage> r)
    {
        D3D12_RESOURCE_DESC desc = {};
        desc.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
        desc.Width = r->width;
        desc.Height = r->height;
        desc.DepthOrArraySize = 1;
        desc.MipLevels = UINT16(r->mipCount);
        desc.Format = r->format;
        desc.SampleDesc.Count = 1;
        desc.Layout = D3D12_TEXTURE_LAYOUT_64KB_UNDEFINED_SWIZZLE;
        if (FAILED(device->CreateReservedResource(&desc, D3D12_RESOURCE_STATE_COMMON, nullptr, IID_PPV_ARGS(&r->resource))))
        {
            fprintf(stderr, "Failed to create a reserved resource (%u x %u, %u levels)\n", r->width, r->height, r->mipCount);
            return false;
        }
        UINT numTiles = 0;
        D3D12_PACKED_MIP_INFO packedMipInfo = {};
        D3D12_SUBRESOURCE_TILING tilings[MAX_MIP_COUNT] = {};
        UINT numTilings = MAX_MIP_COUNT;
        device->GetResourceTiling(r->resource.Get(), &numTiles, &packedMipInfo, nullptr, &numTilings, 0, tilings);
        const size_t mipIndices = packedMipInfo.NumStandardMips + (packedMipInfo.NumPackedMips > 0 ? 1 : 0);
        r->mips.resize(mipIndices);
        for (size_t i = 0; i < mipIndices; ++i)
        {
            ResourceMip& m = r->mips[i];
            if (tilings[i].StartTileIndexInOverallResource == 0xFFFFFFFF)
            {
                m.widthInTiles = 0;
                m.heightInTiles = 0;
                m.numTiles = packedMipInfo.NumTilesForPackedMips;
            }
            else
            {
                m.widthInTiles = tilings[i].WidthInTiles;
                m.heightInTiles = tilings[i].HeightInTiles;
                m.numTiles = m.widthInTiles * m.heightInTiles;
            }
        }
        r->packedMipTileCount = packedMipInfo.NumTilesForPackedMips;
        r->numStandardMips = packedMipInfo.NumStandardMips;
        r->numPackedMips = packedMipInfo.NumPackedMips;
        r->mostDetailedMipResident = uint8_t(packedMipInfo.NumStandardMips + packedMipInfo.NumPackedMips);
        r->visibleMip = UNDEFINED_MIPMAP_INDEX;
        r->prefetchMip = UNDEFINED_MIPMAP_INDEX;
        r->mipRestriction = 0;
        r->trimLimit = ERTP_None;
        r->ignoreBudget = false;

        // NVRHI's handle for drawing, kept in the ShaderResource state (see above).
        nvrhi::TextureDesc textureDesc;
        textureDesc.width = r->width;
        textureDesc.height = r->height;
        textureDesc.mipLevels = r->mipCount;
        textureDesc.format = r->format == DXGI_FORMAT_BC1_UNORM ? nvrhi::Format::BC1_UNORM : nvrhi::Format::RGBA8_UNORM;
        textureDesc.dimension = nvrhi::TextureDimension::Texture2D;
        textureDesc.initialState = nvrhi::ResourceStates::ShaderResource;
        textureDesc.keepInitialState = true;
        textureDesc.debugName = "Paged image";
        r->texture = nvrhiDevice->createHandleForNativeTexture(nvrhi::ObjectTypes::D3D12_Resource, r->resource.Get(), textureDesc);
        if (!r->texture)
            return false;

        PagedImage* raw = r.get();
        raw->commitmentList = -1;
        uncommitted.push_back(raw);
        images.push_back(std::move(r));
        EnqueueResource(raw);
        return true;
    }

    // A DDS file (legacy header or DX10, BC1 or 8-bit RGBA) with its levels.
    std::unique_ptr<PagedImage> LoadDds(const char* path)
    {
        FILE* f = fopen(path, "rb");
        if (!f)
            return nullptr;
        auto r = std::make_unique<PagedImage>();
        fseek(f, 0, SEEK_END);
        r->file.resize(size_t(ftell(f)));
        fseek(f, 0, SEEK_SET);
        const size_t read = fread(r->file.data(), 1, r->file.size(), f);
        fclose(f);
        const std::vector<uint8_t>& d = r->file;
        if (read != d.size() || d.size() < 128 || memcmp(d.data(), "DDS ", 4) != 0)
            return nullptr;
        auto u32 = [&](size_t offset) { uint32_t v; memcpy(&v, d.data() + offset, 4); return v; };
        r->height = u32(12);
        r->width = u32(16);
        r->mipCount = std::max(u32(28), 1u);
        const uint32_t fourCC = u32(84);
        size_t offset = 128;
        bool blockCompressed = false;
        if (fourCC == 0x31545844) // "DXT1"
        {
            r->format = DXGI_FORMAT_BC1_UNORM;
            blockCompressed = true;
        }
        else if (fourCC == 0x30315844) // "DX10"
        {
            const uint32_t dxgiFormat = u32(128);
            offset += 20;
            if (dxgiFormat == DXGI_FORMAT_BC1_UNORM || dxgiFormat == DXGI_FORMAT_R8G8B8A8_UNORM)
                r->format = DXGI_FORMAT(dxgiFormat);
            blockCompressed = dxgiFormat == DXGI_FORMAT_BC1_UNORM;
        }
        else if (u32(88) == 32)
        {
            r->format = DXGI_FORMAT_R8G8B8A8_UNORM;
        }
        if (r->format == DXGI_FORMAT_UNKNOWN)
            return nullptr;
        for (UINT mip = 0; mip < r->mipCount; mip++)
        {
            const UINT w = std::max(r->width >> mip, 1u);
            const UINT h = std::max(r->height >> mip, 1u);
            const size_t size = blockCompressed ? size_t((w + 3) / 4) * ((h + 3) / 4) * 8 : size_t(w) * h * 4;
            r->levelOffsets.push_back(offset);
            offset += size;
        }
        if (offset > d.size())
            return nullptr;
        return r;
    }

    bool Init(nvrhi::IDevice* nvrhiDevice_, const char* ddsPath, int generatedCount)
    {
        nvrhiDevice = nvrhiDevice_;
        if (nvrhiDevice->getGraphicsAPI() != nvrhi::GraphicsAPI::D3D12)
            return false;
        device = static_cast<ID3D12Device*>(nvrhiDevice->getNativeObject(nvrhi::ObjectTypes::D3D12_Device).pointer);
        graphicsQueue = static_cast<ID3D12CommandQueue*>(
            nvrhiDevice->getNativeQueue(nvrhi::ObjectTypes::D3D12_CommandQueue, nvrhi::CommandQueue::Graphics).pointer);
        D3D12_FEATURE_DATA_D3D12_OPTIONS options = {};
        if (FAILED(device->CheckFeatureSupport(D3D12_FEATURE_D3D12_OPTIONS, &options, sizeof(options)))
            || options.TiledResourcesTier == D3D12_TILED_RESOURCES_TIER_NOT_SUPPORTED)
        {
            fprintf(stderr, "The device has no tiled resources\n");
            return false;
        }

        // The adapter, for its memory budget.
        ComPtr<IDXGIFactory4> factory;
        if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))
            || FAILED(factory->EnumAdapterByLuid(device->GetAdapterLuid(), IID_PPV_ARGS(&adapter))))
            return false;

        D3D12_COMMAND_QUEUE_DESC queueDesc = {};
        queueDesc.Type = D3D12_COMMAND_LIST_TYPE_COPY;
        if (FAILED(device->CreateCommandQueue(&queueDesc, IID_PPV_ARGS(&copyQueue)))
            || FAILED(device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_COPY, IID_PPV_ARGS(&copyAllocator)))
            || FAILED(device->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_COPY, copyAllocator.Get(), nullptr, IID_PPV_ARGS(&copyList)))
            || FAILED(device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&copyFence)))
            || FAILED(device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&renderFence))))
            return false;
        copyQueue->SetName(L"Paging copy queue");
        copyEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        renderEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        wakeSubmission = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        wakeBudget = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        shutdown = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        budgetRegistered = SUCCEEDED(adapter->RegisterVideoMemoryBudgetChangeNotificationEvent(wakeBudget, &budgetCookie));
        UpdateVideoMemoryInfo();

        // LoadAssets: the file's image, then the generated ones (queued for paging).
        if (ddsPath && *ddsPath)
        {
            auto r = LoadDds(ddsPath);
            if (r)
                CreateResource(std::move(r));
            else
                fprintf(stderr, "Cannot load %s\n", ddsPath);
        }
        for (int i = 0; i < generatedCount; i++)
        {
            auto r = std::make_unique<PagedImage>();
            r->generatedImageIndex = i;
            r->mipCount = 13;
            r->width = 1u << (r->mipCount - 1);
            r->height = r->width;
            r->format = DXGI_FORMAT_R8G8B8A8_UNORM;
            CreateResource(std::move(r));
        }

        // The paging thread, once the images (and the lists it walks) exist.
        thread = std::thread([this]() { Run(); });
        return true;
    }

    ~PagedImageSet()
    {
        if (shutdown)
            SetEvent(shutdown);
        if (thread.joinable())
            thread.join();
        if (budgetRegistered)
            adapter->UnregisterVideoMemoryBudgetChangeNotification(budgetCookie);
        // The GPU done with the frames and the copies.
        if (graphicsQueue && renderFence)
        {
            graphicsQueue->Signal(renderFence.Get(), ++frameNumber);
            renderFence->SetEventOnCompletion(frameNumber, renderEvent);
            WaitForSingleObject(renderEvent, INFINITE);
        }
        for (auto& image : images)
            image->texture = nullptr;
        images.clear();
        for (HANDLE h : { copyEvent, renderEvent, wakeSubmission, wakeBudget, shutdown })
        {
            if (h)
                CloseHandle(h);
        }
    }
};

extern "C"
{
    // Images streamed into video memory a mip level at a time under the memory budget
    // (core/paged_images.cpp, linked only into the examples that list it): DirectX-Graphics-Samples'
    // D3D12MemoryManagement's paging. Initialize it with Donut_InitPagedImageSet; free it with
    // Donut_DestroyPagedImageSet before the app.
    DONUT_API PagedImageSet* Donut_CreatePagedImageSet()
    {
        return new PagedImageSet();
    }

    DONUT_API void Donut_DestroyPagedImageSet(PagedImageSet* pagedImageSet)
    {
        delete pagedImageSet;
    }

    // Starts the paging thread and creates the images: a DDS file's (ddsPath, relative to the
    // working directory; empty: none) then generatedCount checkerboards. device is the app's
    // nvrhi::IDevice (Donut_GetNvrhiDevice), a D3D12 one with tiled resources. Returns 0 on failure.
    DONUT_API int Donut_InitPagedImageSet(PagedImageSet* pagedImageSet, void* device, const char* ddsPath, int generatedCount)
    {
        return pagedImageSet->Init(static_cast<nvrhi::IDevice*>(device), ddsPath, generatedCount) ? 1 : 0;
    }

    DONUT_API int Donut_GetPagedImageCount(PagedImageSet* pagedImageSet)
    {
        return int(pagedImageSet->images.size());
    }

    // An image's size and level count, and NVRHI's handle for its texture (to draw from with an SRV
    // of the levels from Donut_ReferencePagedImage's on).
    DONUT_API int Donut_GetPagedImageWidth(PagedImageSet* pagedImageSet, int image)
    {
        return int(pagedImageSet->images[image]->width);
    }

    DONUT_API int Donut_GetPagedImageHeight(PagedImageSet* pagedImageSet, int image)
    {
        return int(pagedImageSet->images[image]->height);
    }

    DONUT_API int Donut_GetPagedImageMipCount(PagedImageSet* pagedImageSet, int image)
    {
        return int(pagedImageSet->images[image]->MipCount());
    }

    DONUT_API nvrhi::ITexture* Donut_GetPagedImageTexture(PagedImageSet* pagedImageSet, int image)
    {
        return pagedImageSet->images[image]->texture;
    }

    // The most detailed level resident (the level count: none yet).
    DONUT_API int Donut_GetPagedImageResidentMip(PagedImageSet* pagedImageSet, int image)
    {
        return pagedImageSet->images[image]->mostDetailedMipResident;
    }

    // Starts a frame of the render thread: the previous one's commands, submitted by now, are
    // marked on the graphics queue (the paging thread waits for that before evicting what it drew).
    DONUT_API void Donut_BeginPagedImageFrame(PagedImageSet* pagedImageSet)
    {
        PagedImageSet* s = pagedImageSet;
        if (s->frameNumber > 0)
            s->graphicsQueue->Signal(s->renderFence.Get(), s->frameNumber);
        ++s->frameNumber;
    }

    // An image's visible level (on screen at the scene camera's zoom) and level to prefetch
    // (UNDEFINED, 15: none), from the render thread; the paging thread reprioritizes it when they
    // change.
    DONUT_API void Donut_SetPagedImageMips(PagedImageSet* pagedImageSet, int image, int visibleMip, int prefetchMip)
    {
        PagedImage* r = pagedImageSet->images[image].get();
        if (r->visibleMip != visibleMip || r->prefetchMip != prefetchMip)
        {
            r->visibleMip = uint8_t(visibleMip);
            r->prefetchMip = uint8_t(prefetchMip);
            pagedImageSet->EnqueueResource(r);
        }
    }

    // ReferenceResource: the level this frame draws an image from for the requested one: no more
    // detailed than resident or the trimming restriction allows; the paging thread won't evict its
    // heap until the GPU has finished this frame.
    DONUT_API int Donut_ReferencePagedImage(PagedImageSet* pagedImageSet, int image, int requestedMip)
    {
        PagedImage* r = pagedImageSet->images[image].get();
        uint8_t requested = std::min(uint8_t(requestedMip), uint8_t(r->MipCount() - 1));
        std::lock_guard<std::mutex> lock(r->referenceLock);
        uint8_t mip = std::max(requested, uint8_t(r->mostDetailedMipResident));
        mip = std::max(mip, uint8_t(r->mipRestriction));
        r->mips[r->MipHeapIndex(mip)].referenceFence = pagedImageSet->frameNumber;
        return mip;
    }

    // Local video memory usage and budget (bytes), as the paging thread last saw them, the budget
    // override applied.
    DONUT_API double Donut_GetPagedImageSetUsage(PagedImageSet* pagedImageSet)
    {
        return double(pagedImageSet->localUsage.load());
    }

    DONUT_API double Donut_GetPagedImageSetBudget(PagedImageSet* pagedImageSet)
    {
        return double(pagedImageSet->localBudget.load());
    }

    // The budget the paging thread keeps to instead of the kernel's (bytes; 0: the kernel's).
    DONUT_API void Donut_SetPagedImageSetBudgetOverride(PagedImageSet* pagedImageSet, double bytes)
    {
        pagedImageSet->localBudgetOverride = uint64_t(bytes);
        SetEvent(pagedImageSet->wakeBudget);
    }

    DONUT_API double Donut_GetPagedImageSetBudgetOverride(PagedImageSet* pagedImageSet)
    {
        return double(pagedImageSet->localBudgetOverride.load());
    }

    // Waits (up to timeoutMs) for the paging thread to run out of work, or to wait for a frame to
    // finish (which only the next frames bring). Returns 1 if it did.
    DONUT_API int Donut_WaitForPagedImagesIdle(PagedImageSet* pagedImageSet, int timeoutMs)
    {
        PagedImageSet* s = pagedImageSet;
        std::unique_lock<std::mutex> lock(s->idleMutex);
        return s->idleChanged.wait_for(lock, std::chrono::milliseconds(timeoutMs), [s]() {
            return (s->idle && s->idleSubmissions == s->submissions.load()) || s->waitingForFrame;
        }) ? 1 : 0;
    }
}
#endif

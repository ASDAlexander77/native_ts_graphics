// Opacity micromaps baked at run time (opacity_micromaps -bake): the GPU baker of NVIDIA's Opacity
// Micro-Map SDK (github.com/NVIDIAGameWorks/Opacity-MicroMap-SDK) through its NVRHI layer
// (omm::GpuBakeNvrhi). The SDK is fetched at configure time (WITH_OMM_SDK; see CMakeLists.txt) and
// not part of this repository; without it (other platforms) Donut_CreateOmmBaker returns null.
//
// A bake takes one geometry: its alpha texture, texture coordinates and indices, and makes what
// Donut_CreateOpacityMicromap and Donut_SetTriangleBlasGeometryOpacityMicromap take, as the
// sample's offline micromap files hold it: the array's raw data and descs, an OMM index per
// triangle (or a special index: fully opaque, transparent or unknown), and the histograms of the
// array (the OMMs of a subdivision level and format) and of the indices (the triangles using them).
// It runs in two passes, executed and waited for here: the setup pass sizes the array and writes
// the descs, indices and histograms; the bake pass writes the array data (and the stats).

#include <nvrhi/nvrhi.h>
#include <donut/core/log.h>

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <memory>
#include <vector>

#include "donut_api.h"

#if defined(DONUT_WITH_OMM_SDK)
#include <omm-gpu-nvrhi.h>
#endif

namespace
{
    // A bake's results, kept by its baker.
    struct OmmBakeResult
    {
        nvrhi::BufferHandle arrayBuffer;
        nvrhi::BufferHandle descBuffer;
        nvrhi::BufferHandle indexBuffer;
        nvrhi::Format indexFormat = nvrhi::Format::R32_UINT;
        int indexCount = 0;
        // Entries of (count, subdivision level, format).
        std::vector<int> arrayHistogram;
        std::vector<int> indexHistogram;
        // omm::GpuBakeNvrhi::PostDispatchInfo's: array and desc sizes, then the micro-triangles
        // opaque, transparent, unknown, and the OMMs fully opaque, transparent, unknown.
        uint32_t stats[8] = {};
    };
}

struct OmmBaker
{
    nvrhi::DeviceHandle device;
#if defined(DONUT_WITH_OMM_SDK)
    std::unique_ptr<omm::GpuBakeNvrhi> baker;
#endif
    std::vector<OmmBakeResult> results;
};

#if defined(DONUT_WITH_OMM_SDK)
namespace
{
    // The baker's outputs: raw UAVs; the array, descs and indices also acceleration structure build
    // inputs. Each command list using one starts it in its initial state and puts it back.
    nvrhi::BufferHandle CreateOutputBuffer(nvrhi::IDevice* device, size_t byteSize, bool buildInput, const char* debugName)
    {
        auto desc = nvrhi::BufferDesc()
            .setByteSize(std::max<size_t>(byteSize, 4))
            .setFormat(nvrhi::Format::R32_UINT)
            .setCanHaveUAVs(true)
            .setCanHaveRawViews(true)
            .setIsAccelStructBuildInput(buildInput)
            .setDebugName(debugName)
            .setInitialState(buildInput ? nvrhi::ResourceStates::ShaderResource | nvrhi::ResourceStates::AccelStructBuildInput
                                        : nvrhi::ResourceStates::Common)
            .setKeepInitialState(true);
        return device->createBuffer(desc);
    }

    size_t AlignUp(size_t size)
    {
        return (size + 255) & ~size_t(255);
    }

    void ExecuteAndWait(nvrhi::IDevice* device, nvrhi::ICommandList* commandList)
    {
        commandList->close();
        device->executeCommandList(commandList);
        device->waitForIdle();
    }

    void ReadHistogram(const uint8_t* data, size_t byteSize, std::vector<int>& histogram)
    {
        std::vector<nvrhi::rt::OpacityMicromapUsageCount> counts;
        omm::GpuBakeNvrhi::ReadUsageDescBuffer(const_cast<uint8_t*>(data), byteSize, counts);
        histogram.clear();
        for (const auto& count : counts)
        {
            histogram.push_back(int(count.count));
            histogram.push_back(int(count.subdivisionLevel));
            histogram.push_back(int(count.format));
        }
    }
}
#endif

extern "C"
{
    // The Opacity Micro-Map SDK's GPU baker (core/omm_bake.cpp, linked only into the examples that
    // list it) on the app's device (Donut_GetNvrhiDevice; D3D12 or Vulkan). Returns null without the
    // SDK (WITH_OMM_SDK, Windows) or on failure. Free it with Donut_DestroyOmmBaker before the app:
    // it holds its bakes' buffers.
    DONUT_API OmmBaker* Donut_CreateOmmBaker(void* device)
    {
#if defined(DONUT_WITH_OMM_SDK)
        auto* nvrhiDevice = static_cast<nvrhi::IDevice*>(device);
        auto ommBaker = std::make_unique<OmmBaker>();
        ommBaker->device = nvrhiDevice;
        // Its constructor uploads static buffers into an open command list.
        nvrhi::CommandListHandle commandList = nvrhiDevice->createCommandList();
        commandList->open();
        ommBaker->baker = std::make_unique<omm::GpuBakeNvrhi>(nvrhiDevice, commandList, false, nullptr,
            [](omm::MessageSeverity severity, const char* message) {
                if (severity == omm::MessageSeverity::Info)
                    donut::log::info("OMM baker: %s", message);
                else if (severity == omm::MessageSeverity::PerfWarning)
                    donut::log::warning("OMM baker: %s", message);
                else
                    donut::log::error("OMM baker: %s", message);
            });
        ExecuteAndWait(nvrhiDevice, commandList);
        return ommBaker.release();
#else
        (void)device;
        donut::log::warning("Built without the Opacity Micro-Map SDK (WITH_OMM_SDK, Windows): no micromap baking");
        return nullptr;
#endif
    }

    DONUT_API void Donut_DestroyOmmBaker(OmmBaker* ommBaker)
    {
        delete ommBaker;
    }

    // Bakes one geometry's opacity micromaps: alphaTexture's channel alphaChannel against alphaCutoff
    // (above: opaque) at the texture coordinates (two floats each) of texCoordBuffer (a raw view
    // buffer), indexed by indexCount 32-bit indices of indexBuffer from its index indexOffset (an OMM
    // index per triangle, in that order). maxSubdivisionLevel: 1-12; use4State: 4-state OMMs, else
    // 2-state; dynamicSubdivisionScale: the SDK's (0: every OMM at maxSubdivisionLevel; else
    // smaller triangles in texture space get lower levels). Waits for the GPU. Returns the bake's
    // index for the getters, or -1 on failure.
    DONUT_API int Donut_OmmBakerBake(OmmBaker* ommBaker, nvrhi::ITexture* alphaTexture, int alphaChannel, double alphaCutoff,
        nvrhi::IBuffer* texCoordBuffer, nvrhi::IBuffer* indexBuffer, int indexOffset, int indexCount,
        int maxSubdivisionLevel, bool use4State, double dynamicSubdivisionScale)
    {
#if defined(DONUT_WITH_OMM_SDK)
        nvrhi::IDevice* device = ommBaker->device;

        // The baker takes the index format from the index buffer's: a typed copy of the geometry's.
        const size_t indexBytes = size_t(indexCount) * 4;
        nvrhi::BufferHandle indices = device->createBuffer(nvrhi::BufferDesc()
            .setByteSize(indexBytes)
            .setFormat(nvrhi::Format::R32_UINT)
            .setCanHaveTypedViews(true)
            .setCanHaveRawViews(true)
            .setDebugName("OMM Bake Indices")
            .setInitialState(nvrhi::ResourceStates::ShaderResource)
            .setKeepInitialState(true));

        omm::GpuBakeNvrhi::Input input;
        input.alphaTexture = alphaTexture;
        input.alphaTextureChannel = uint32_t(alphaChannel);
        input.alphaCutoff = float(alphaCutoff);
        input.bilinearFilter = true;
        input.enableLevelLineIntersection = true;
        input.sampleMode = nvrhi::SamplerAddressMode::Wrap;
        input.texCoordFormat = nvrhi::Format::R32_FLOAT;
        input.texCoordBuffer = texCoordBuffer;
        input.texCoordStrideInBytes = 8;
        input.indexBuffer = indices;
        input.numIndices = uint32_t(indexCount);
        input.maxSubdivisionLevel = uint32_t(maxSubdivisionLevel);
        input.format = use4State ? nvrhi::rt::OpacityMicromapFormat::OC1_4_State : nvrhi::rt::OpacityMicromapFormat::OC1_2_State;
        input.dynamicSubdivisionScale = float(dynamicSubdivisionScale);
        input.enableStats = true;
        // Compute shaders only: the rasterizing path supports subdivision levels up to 10, and on
        // Vulkan its viewports exceed maxViewportDimensions.
        input.computeOnly = true;

        input.operation = omm::GpuBakeNvrhi::Operation::Setup;
        omm::GpuBakeNvrhi::PreDispatchInfo info;
        ommBaker->baker->GetPreDispatchInfo(input, info);
        if (info.ommIndexFormat != nvrhi::Format::R16_UINT && info.ommIndexFormat != nvrhi::Format::R32_UINT)
        {
            input.force32BitIndices = true;
            ommBaker->baker->GetPreDispatchInfo(input, info);
        }

        OmmBakeResult result;
        result.indexFormat = info.ommIndexFormat;
        result.indexCount = int(info.ommIndexCount);
        omm::GpuBakeNvrhi::Buffers buffers;
        buffers.ommDescBuffer = result.descBuffer = CreateOutputBuffer(device, info.ommDescBufferSize, true, "OMM Desc Buffer");
        buffers.ommIndexBuffer = result.indexBuffer = CreateOutputBuffer(device, info.ommIndexBufferSize, true, "OMM Index Buffer");
        buffers.ommDescArrayHistogramBuffer = CreateOutputBuffer(device, info.ommDescArrayHistogramSize, false, "OMM Array Histogram");
        buffers.ommIndexHistogramBuffer = CreateOutputBuffer(device, info.ommIndexHistogramSize, false, "OMM Index Histogram");
        buffers.ommPostDispatchInfoBuffer = CreateOutputBuffer(device, info.ommPostDispatchInfoBufferSize, false, "OMM Post Dispatch Info");

        // The histograms and the post dispatch info, read back after each pass.
        const size_t arrayHistogramOffset = 0;
        const size_t indexHistogramOffset = AlignUp(info.ommDescArrayHistogramSize);
        const size_t postDispatchOffset = indexHistogramOffset + AlignUp(info.ommIndexHistogramSize);
        nvrhi::BufferHandle readback = device->createBuffer(nvrhi::BufferDesc()
            .setByteSize(postDispatchOffset + AlignUp(info.ommPostDispatchInfoBufferSize))
            .setCpuAccess(nvrhi::CpuAccessMode::Read)
            .setDebugName("OMM Bake Readback")
            .setInitialState(nvrhi::ResourceStates::CopyDest)
            .setKeepInitialState(true));
        auto copyToReadback = [&](nvrhi::ICommandList* commandList) {
            commandList->copyBuffer(readback, arrayHistogramOffset, buffers.ommDescArrayHistogramBuffer, 0, info.ommDescArrayHistogramSize);
            commandList->copyBuffer(readback, indexHistogramOffset, buffers.ommIndexHistogramBuffer, 0, info.ommIndexHistogramSize);
            commandList->copyBuffer(readback, postDispatchOffset, buffers.ommPostDispatchInfoBuffer, 0, info.ommPostDispatchInfoBufferSize);
        };
        auto readBack = [&]() {
            auto* data = static_cast<const uint8_t*>(device->mapBuffer(readback, nvrhi::CpuAccessMode::Read));
            if (!data)
                return false;
            ReadHistogram(data + arrayHistogramOffset, info.ommDescArrayHistogramSize, result.arrayHistogram);
            ReadHistogram(data + indexHistogramOffset, info.ommIndexHistogramSize, result.indexHistogram);
            omm::GpuBakeNvrhi::PostDispatchInfo postDispatchInfo;
            omm::GpuBakeNvrhi::ReadPostDispatchInfo(const_cast<uint8_t*>(data + postDispatchOffset), sizeof(postDispatchInfo), postDispatchInfo);
            static_assert(sizeof(postDispatchInfo) == sizeof(result.stats));
            std::memcpy(result.stats, &postDispatchInfo, sizeof(result.stats));
            device->unmapBuffer(readback);
            return true;
        };

        // Setup: the descs, indices and histograms, and the array's size.
        nvrhi::CommandListHandle commandList = device->createCommandList();
        commandList->open();
        commandList->copyBuffer(indices, 0, indexBuffer, uint64_t(indexOffset) * 4, indexBytes);
        ommBaker->baker->Dispatch(commandList, input, buffers);
        copyToReadback(commandList);
        ExecuteAndWait(device, commandList);
        if (!readBack())
        {
            donut::log::error("Donut_OmmBakerBake: cannot read the setup pass's results back");
            return -1;
        }

        // Bake: the array data, in a buffer of the size the setup pass found.
        input.operation = omm::GpuBakeNvrhi::Operation::Bake;
        buffers.ommArrayBuffer = result.arrayBuffer = CreateOutputBuffer(device, result.stats[0], true, "OMM Array Buffer");
        commandList->open();
        ommBaker->baker->Dispatch(commandList, input, buffers);
        copyToReadback(commandList);
        ExecuteAndWait(device, commandList);
        if (!readBack())
        {
            donut::log::error("Donut_OmmBakerBake: cannot read the bake pass's results back");
            return -1;
        }
        ommBaker->baker->Clear();

        ommBaker->results.push_back(std::move(result));
        return int(ommBaker->results.size()) - 1;
#else
        (void)ommBaker; (void)alphaTexture; (void)alphaChannel; (void)alphaCutoff; (void)texCoordBuffer; (void)indexBuffer;
        (void)indexOffset; (void)indexCount; (void)maxSubdivisionLevel; (void)use4State; (void)dynamicSubdivisionScale;
        return -1;
#endif
    }

    // A bake's array data, descs and OMM indices (acceleration structure build inputs; the baker's:
    // don't release them), and the indices' format (R16_UINT or R32_UINT) and count.
    DONUT_API nvrhi::IBuffer* Donut_GetOmmBakerArrayBuffer(OmmBaker* ommBaker, int bake)
    {
        return ommBaker->results[bake].arrayBuffer;
    }

    DONUT_API nvrhi::IBuffer* Donut_GetOmmBakerDescBuffer(OmmBaker* ommBaker, int bake)
    {
        return ommBaker->results[bake].descBuffer;
    }

    DONUT_API nvrhi::IBuffer* Donut_GetOmmBakerIndexBuffer(OmmBaker* ommBaker, int bake)
    {
        return ommBaker->results[bake].indexBuffer;
    }

    DONUT_API int Donut_GetOmmBakerIndexFormat(OmmBaker* ommBaker, int bake)
    {
        return int(ommBaker->results[bake].indexFormat);
    }

    DONUT_API int Donut_GetOmmBakerIndexCount(OmmBaker* ommBaker, int bake)
    {
        return ommBaker->results[bake].indexCount;
    }

    // A bake's histograms: up to maxEntries entries of three ints (count, subdivision level,
    // format) into dst; returns the entries there are. The array's is what
    // Donut_CreateOpacityMicromap takes, the indices' Donut_SetTriangleBlasGeometryOpacityMicromap.
    DONUT_API int Donut_GetOmmBakerArrayHistogram(OmmBaker* ommBaker, int bake, int* dst, int maxEntries)
    {
        const auto& histogram = ommBaker->results[bake].arrayHistogram;
        const int entries = int(histogram.size() / 3);
        std::memcpy(dst, histogram.data(), size_t(std::min(entries, maxEntries)) * 3 * sizeof(int));
        return entries;
    }

    DONUT_API int Donut_GetOmmBakerIndexHistogram(OmmBaker* ommBaker, int bake, int* dst, int maxEntries)
    {
        const auto& histogram = ommBaker->results[bake].indexHistogram;
        const int entries = int(histogram.size() / 3);
        std::memcpy(dst, histogram.data(), size_t(std::min(entries, maxEntries)) * 3 * sizeof(int));
        return entries;
    }

    // A bake's stats, 0-7: the array's and descs' sizes (bytes), the micro-triangles opaque,
    // transparent and unknown, the OMMs fully opaque, transparent and unknown.
    DONUT_API int Donut_GetOmmBakerStat(OmmBaker* ommBaker, int bake, int stat)
    {
        return int(ommBaker->results[bake].stats[stat]);
    }
}

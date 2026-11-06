// Partitioned top level acceleration structures (PTLAS): Vulkan's VK_NV_partitioned_acceleration_structure
// and D3D12's preview PTLAS (Agility SDK 1.722.0-preview, ID3D12DeviceRaytracing2 /
// ID3D12CommandListRaytracing2; devblogs.microsoft.com/directx/clas-ptlas-preview). A PTLAS holds a
// fixed number of instance slots in partitions plus a global partition; a build applies operations
// read from GPU memory - writes of whole instances, updates of their BLAS and hit group, and
// translations of whole partitions - to the previous PTLAS, in place, so that only the partitions
// they touch are rebuilt. Shaders trace it as any TLAS; NVRHI binds it by its buffer
// (ResourceType::RayTracingPartitionedAccelStruct, patches/nvrhi-partitioned-accel-struct-binding.patch).
//
// NVRHI has no PTLAS builds: this file makes them through the native APIs, on NVRHI's command lists
// (Vulkan through vkGetDeviceProcAddr; D3D12 through the preview headers, which only this file
// includes - CMakeLists.txt generates ptlas_d3d12_preview.h to point at them), with NVRHI's state
// tracking for the barriers around them. A Ptlas owns its storage, scratch and operation buffers,
// and the argument buffers the operations read, which shaders write (raw UAVs) - the 104-byte
// instance writes are laid out differently on the two APIs (see shaders/ptlas.hlsl). It also owns an
// ordinary TLAS of up to as many instances, built from a buffer of D3D12_RAYTRACING_INSTANCE_DESC /
// VkAccelerationStructureInstanceKHR (the same 64 bytes on both), for checking a PTLAS against.
//
// On D3D12 the preview runtime has to be loaded (core/d3d12_preview_sdk.cpp exports its version
// and folder; Windows' Developer Mode on) and its experimental features enabled before the device is
// created: Donut_EnableD3D12RaytracingPreview.

#include <nvrhi/nvrhi.h>
#include <donut/core/log.h>

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>

#include "donut_api.h"

#if defined(DONUT_PTLAS_WITH_D3D12_PREVIEW)
#include <windows.h>
#include <initguid.h>
// #include "<the preview Agility SDK>/build/native/include/d3d12.h": before anything includes another.
#include "ptlas_d3d12_preview.h"
#if defined(DONUT_INTEROP_SHARED)
// core/donut_interop.cpp: under tslang's JIT (whose tslang.exe exports no D3D12SDKVersion), loads the
// runtime in bin/<folder> in place of the executable's export.
bool UseD3D12RuntimeUnderJit(const char* folder, unsigned version);
#endif
#endif

#define VK_NO_PROTOTYPES
#include <vulkan/vulkan.h>

#if defined(_WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace
{
    // Donut_CreatePtlas's flags; D3D12_RTAS_PARTITIONED_TLAS_FLAGS' values.
    constexpr int PtlasFlag_FastTrace = 1;
    constexpr int PtlasFlag_FastBuild = 2;
    constexpr int PtlasFlag_PartitionTranslation = 4;
    // Not an API flag: the reference TLAS allows updates (Donut_UpdatePtlasReferenceTlas refits it).
    constexpr int PtlasFlag_UpdatableReferenceTlas = 8;

    // The argument records of the three operations, the same size on both APIs.
    constexpr uint32_t WriteInstanceStride = 104;
    constexpr uint32_t UpdateInstanceStride = 16;
    constexpr uint32_t TranslatePartitionStride = 16;
    // D3D12_RAYTRACING_INSTANCE_DESC / VkAccelerationStructureInstanceKHR.
    constexpr uint32_t TlasInstanceStride = 64;

    // VkBuildPartitionedAccelerationStructureIndirectCommandNV / D3D12_RTAS_PARTITIONED_TLAS_OPERATION:
    // the operation type (write instance 0, update instance 1, translate partition 2, on both), its
    // argument count, and its arguments' address and stride.
    struct PtlasOperation
    {
        uint32_t type;
        uint32_t argCount;
        uint64_t argAddress;
        uint64_t argStride;
    };
    static_assert(sizeof(PtlasOperation) == 24);

    // The operation buffer: the count (4-byte aligned), then the operations (8-byte aligned).
    constexpr uint32_t OperationsOffset = 8;
    constexpr uint32_t MaxOperations = 3;

    struct VulkanFunctions
    {
        PFN_vkGetPartitionedAccelerationStructuresBuildSizesNV getBuildSizes = nullptr;
        PFN_vkCmdBuildPartitionedAccelerationStructuresNV cmdBuild = nullptr;
        PFN_vkGetAccelerationStructureDeviceAddressKHR getAccelStructAddress = nullptr;
    };

    // vkGetDeviceProcAddr from the Vulkan loader Donut loaded (a device's functions of extensions it
    // didn't enable come back null).
    PFN_vkGetDeviceProcAddr GetDeviceProcAddr()
    {
#if defined(_WIN32)
        HMODULE loader = GetModuleHandleA("vulkan-1.dll");
        return loader ? reinterpret_cast<PFN_vkGetDeviceProcAddr>(GetProcAddress(loader, "vkGetDeviceProcAddr")) : nullptr;
#else
        void* loader = dlopen("libvulkan.so", RTLD_NOW | RTLD_NOLOAD);
        if (!loader)
            loader = dlopen("libvulkan.so.1", RTLD_NOW | RTLD_NOLOAD);
        return loader ? reinterpret_cast<PFN_vkGetDeviceProcAddr>(dlsym(loader, "vkGetDeviceProcAddr")) : nullptr;
#endif
    }

    bool LoadVulkanFunctions(nvrhi::IDevice* device, VulkanFunctions& functions)
    {
        PFN_vkGetDeviceProcAddr getDeviceProcAddr = GetDeviceProcAddr();
        VkDevice vkDevice = device->getNativeObject(nvrhi::ObjectTypes::VK_Device);
        if (!getDeviceProcAddr || !vkDevice)
            return false;
        functions.getBuildSizes = reinterpret_cast<PFN_vkGetPartitionedAccelerationStructuresBuildSizesNV>(
            getDeviceProcAddr(vkDevice, "vkGetPartitionedAccelerationStructuresBuildSizesNV"));
        functions.cmdBuild = reinterpret_cast<PFN_vkCmdBuildPartitionedAccelerationStructuresNV>(
            getDeviceProcAddr(vkDevice, "vkCmdBuildPartitionedAccelerationStructuresNV"));
        functions.getAccelStructAddress = reinterpret_cast<PFN_vkGetAccelerationStructureDeviceAddressKHR>(
            getDeviceProcAddr(vkDevice, "vkGetAccelerationStructureDeviceAddressKHR"));
        return functions.getBuildSizes && functions.cmdBuild && functions.getAccelStructAddress;
    }

#if defined(DONUT_PTLAS_WITH_D3D12_PREVIEW)
    // The device's ID3D12DeviceRaytracing2, if the runtime and driver have PTLASes. Released by the caller.
    ID3D12DeviceRaytracing2* GetD3D12RaytracingDevice(nvrhi::IDevice* device)
    {
        ID3D12Device* d3dDevice = device->getNativeObject(nvrhi::ObjectTypes::D3D12_Device);
        if (!d3dDevice)
            return nullptr;

        ID3D12Device16* device16 = nullptr;
        if (FAILED(d3dDevice->QueryInterface(IID_PPV_ARGS(&device16))))
            return nullptr;
        D3D12_FEATURE_DATA_D3D12_OPTIONS_RAYTRACING2 options = {};
        HRESULT hr = device16->CheckFeatureSupport1(D3D12_FEATURE_D3D12_OPTIONS_RAYTRACING2,
            &options, sizeof(options), D3D12_PREVIEW_SDK_VERSION);
        device16->Release();
        if (FAILED(hr) || !options.ClustersAndPTLASSupported)
            return nullptr;

        ID3D12DeviceRaytracing2* raytracingDevice = nullptr;
        if (FAILED(d3dDevice->QueryInterface(IID_PPV_ARGS(&raytracingDevice))))
            return nullptr;
        return raytracingDevice;
    }

    void FillD3D12Inputs(const D3D12_RTAS_PARTITIONED_TLAS_INPUTS_DESC& ptlasInputs, D3D12_RTAS_OPERATION_INPUTS& inputs)
    {
        inputs = {};
        inputs.Type = D3D12_RTAS_OPERATION_TYPE_PARTITIONED_TLAS;
        inputs.pPartitionedTLASInputsDesc = &ptlasInputs;
    }
#endif
}

struct Ptlas
{
    nvrhi::DeviceHandle device;
    nvrhi::GraphicsAPI api = nvrhi::GraphicsAPI::VULKAN;
    VulkanFunctions vk;

    int instanceCount = 0;
    int maxInstancesPerPartition = 0;
    int partitionCount = 0;
    int maxInstancesInGlobalPartition = 0;
    int flags = 0;

    nvrhi::BufferHandle storage;
    nvrhi::BufferHandle scratch;
    nvrhi::BufferHandle operations;
    nvrhi::BufferHandle writeInstanceArgs;
    nvrhi::BufferHandle updateInstanceArgs;
    nvrhi::BufferHandle translatePartitionArgs;
    // Built once (no source PTLAS), in place since.
    bool built = false;

    nvrhi::rt::AccelStructHandle referenceTlas;
    nvrhi::BufferHandle referenceInstances;

    nvrhi::rt::AccelStructBuildFlags ReferenceTlasFlags() const
    {
        return (flags & PtlasFlag_UpdatableReferenceTlas) != 0
            ? nvrhi::rt::AccelStructBuildFlags::PreferFastTrace | nvrhi::rt::AccelStructBuildFlags::AllowUpdate
            : nvrhi::rt::AccelStructBuildFlags::PreferFastTrace;
    }

    VkPartitionedAccelerationStructureFlagsNV VulkanFlags() const
    {
        VkPartitionedAccelerationStructureFlagsNV result{ VK_STRUCTURE_TYPE_PARTITIONED_ACCELERATION_STRUCTURE_FLAGS_NV };
        result.enablePartitionTranslation = (flags & PtlasFlag_PartitionTranslation) != 0;
        return result;
    }

    // Chains `vkFlags` (which must outlive it).
    VkPartitionedAccelerationStructureInstancesInputNV VulkanInputs(VkPartitionedAccelerationStructureFlagsNV& vkFlags) const
    {
        VkPartitionedAccelerationStructureInstancesInputNV input{ VK_STRUCTURE_TYPE_PARTITIONED_ACCELERATION_STRUCTURE_INSTANCES_INPUT_NV };
        input.pNext = &vkFlags;
        if (flags & PtlasFlag_FastTrace)
            input.flags |= VK_BUILD_ACCELERATION_STRUCTURE_PREFER_FAST_TRACE_BIT_KHR;
        if (flags & PtlasFlag_FastBuild)
            input.flags |= VK_BUILD_ACCELERATION_STRUCTURE_PREFER_FAST_BUILD_BIT_KHR;
        input.instanceCount = uint32_t(instanceCount);
        input.maxInstancePerPartitionCount = uint32_t(maxInstancesPerPartition);
        input.partitionCount = uint32_t(partitionCount);
        input.maxInstanceInGlobalPartitionCount = uint32_t(maxInstancesInGlobalPartition);
        return input;
    }

#if defined(DONUT_PTLAS_WITH_D3D12_PREVIEW)
    D3D12_RTAS_PARTITIONED_TLAS_INPUTS_DESC D3D12Inputs() const
    {
        D3D12_RTAS_PARTITIONED_TLAS_INPUTS_DESC inputs = {};
        inputs.Flags = D3D12_RTAS_PARTITIONED_TLAS_FLAGS(flags & (PtlasFlag_FastTrace | PtlasFlag_FastBuild | PtlasFlag_PartitionTranslation));
        inputs.InstanceCount = UINT(instanceCount);
        inputs.MaxInstancePerPartitionCount = UINT(maxInstancesPerPartition);
        inputs.PartitionCount = UINT(partitionCount);
        inputs.MaxInstanceInGlobalPartitionCount = UINT(maxInstancesInGlobalPartition);
        return inputs;
    }
#endif
};

namespace
{
    // A raw UAV the build reads its arguments from.
    nvrhi::BufferHandle CreateArgumentBuffer(nvrhi::IDevice* device, uint64_t byteSize, const char* name)
    {
        auto desc = nvrhi::BufferDesc()
            .setByteSize(byteSize)
            .setCanHaveUAVs(true)
            .setCanHaveRawViews(true)
            .setIsAccelStructBuildInput(true)
            .setInitialState(nvrhi::ResourceStates::UnorderedAccess)
            .setKeepInitialState(true)
            .setDebugName(name);
        return device->createBuffer(desc);
    }
}

// Records a build of the PTLAS from the operation buffer's operations: from nothing the first time, in
// place since.
static void RecordPtlasBuild(Ptlas* ptlas, nvrhi::ICommandList* commandList)
{
    commandList->setBufferState(ptlas->operations, nvrhi::ResourceStates::AccelStructBuildInput);
    commandList->setBufferState(ptlas->writeInstanceArgs, nvrhi::ResourceStates::AccelStructBuildInput);
    commandList->setBufferState(ptlas->updateInstanceArgs, nvrhi::ResourceStates::AccelStructBuildInput);
    commandList->setBufferState(ptlas->translatePartitionArgs, nvrhi::ResourceStates::AccelStructBuildInput);
    commandList->setBufferState(ptlas->scratch, nvrhi::ResourceStates::UnorderedAccess);
    commandList->setBufferState(ptlas->storage, nvrhi::ResourceStates::AccelStructWrite);
    commandList->commitBarriers();

    const uint64_t storageAddress = ptlas->storage->getGpuVirtualAddress();
    const uint64_t sourceAddress = ptlas->built ? storageAddress : 0;
    const uint64_t operationsAddress = ptlas->operations->getGpuVirtualAddress();

    if (ptlas->api == nvrhi::GraphicsAPI::VULKAN)
    {
        VkPartitionedAccelerationStructureFlagsNV vkFlags = ptlas->VulkanFlags();
        VkBuildPartitionedAccelerationStructureInfoNV info{ VK_STRUCTURE_TYPE_BUILD_PARTITIONED_ACCELERATION_STRUCTURE_INFO_NV };
        info.input = ptlas->VulkanInputs(vkFlags);
        info.srcAccelerationStructureData = sourceAddress;
        info.dstAccelerationStructureData = storageAddress;
        info.scratchData = ptlas->scratch->getGpuVirtualAddress();
        info.srcInfos = operationsAddress + OperationsOffset;
        info.srcInfosCount = operationsAddress;
        VkCommandBuffer commandBuffer = commandList->getNativeObject(nvrhi::ObjectTypes::VK_CommandBuffer);
        ptlas->vk.cmdBuild(commandBuffer, &info);
    }
#if defined(DONUT_PTLAS_WITH_D3D12_PREVIEW)
    else
    {
        ID3D12GraphicsCommandList* d3dCommandList = commandList->getNativeObject(nvrhi::ObjectTypes::D3D12_GraphicsCommandList);
        ID3D12CommandListRaytracing2* raytracingCommandList = nullptr;
        if (!d3dCommandList || FAILED(d3dCommandList->QueryInterface(IID_PPV_ARGS(&raytracingCommandList))))
        {
            donut::log::error("Donut_BuildPtlas: the command list has no ID3D12CommandListRaytracing2");
            return;
        }
        D3D12_RTAS_PARTITIONED_TLAS_INPUTS_DESC ptlasInputs = ptlas->D3D12Inputs();
        D3D12_RTAS_PARTITIONED_TLAS_OPERATION_DATA operationData = {};
        operationData.SourceAccelerationStructureData = sourceAddress;
        operationData.DestAccelerationStructureData = storageAddress;
        operationData.ScratchAccelerationStructureData = ptlas->scratch->getGpuVirtualAddress();
        operationData.IndirectPartitionedTlasOpCount = operationsAddress;
        operationData.IndirectPartitionedTlasOps = operationsAddress + OperationsOffset;
        D3D12_RTAS_OPERATION_DESC build = {};
        FillD3D12Inputs(ptlasInputs, build.Inputs);
        build.pPartitionedTlasOperationData = &operationData;
        raytracingCommandList->ExecuteIndirectRTASOperations(1, &build, D3D12_EXECUTE_INDIRECT_RTAS_OPERATIONS_FLAG_NONE);
        raytracingCommandList->Release();
    }
#endif
    ptlas->built = true;

    // Traces wait for the build (a UAV barrier on D3D12, which keeps both in one state).
    commandList->setBufferState(ptlas->storage, nvrhi::ResourceStates::AccelStructRead);
    commandList->commitBarriers();
}

extern "C"
{
    // Enables D3D12's experimental features of the PTLAS preview (D3D12ExperimentalShaderModels,
    // D3D12RaytracingPreview), which has to happen before the D3D12 device is created; the executable
    // loads the preview runtime (core/d3d12_preview_sdk.cpp), or under tslang's JIT this library does
    // (UseD3D12RuntimeUnderJit). 1 on success; 0 without the preview
    // headers (not Windows, WITH_D3D12_PREVIEW_SDK off) or when D3D12 refuses: the preview runtime
    // doesn't load without Windows' Developer Mode (D3D12_ERROR_INVALID_REDIST, 0x887E0003).
    DONUT_API int Donut_EnableD3D12RaytracingPreview()
    {
#if defined(DONUT_PTLAS_WITH_D3D12_PREVIEW)
#if defined(DONUT_INTEROP_SHARED)
        UseD3D12RuntimeUnderJit("D3D12Preview", D3D12_PREVIEW_SDK_VERSION);
#endif
        UUID features[] = { D3D12ExperimentalShaderModels, D3D12RaytracingPreview };
        HRESULT hr = D3D12EnableExperimentalFeatures(UINT(sizeof(features) / sizeof(features[0])), features, nullptr, nullptr);
        if (FAILED(hr))
        {
            // Before the app exists (Donut_CreateAppWithOptions sets the console up for its log).
            std::fprintf(stderr, "D3D12EnableExperimentalFeatures failed (0x%08X): the D3D12 PTLAS preview needs "
                "the preview Agility SDK runtime and Windows' Developer Mode\n", unsigned(hr));
            return 0;
        }
        return 1;
#else
        return 0;
#endif
    }

    // A PTLAS on the app's device (Donut_GetNvrhiDevice; Vulkan with VK_NV_partitioned_acceleration_structure,
    // or D3D12 with the preview runtime and a driver reporting ClustersAndPTLASSupported) of
    // instanceCount instance slots, in partitionCount partitions of up to maxInstancesPerPartition
    // and a global partition of up to maxInstancesInGlobalPartition; flags: 1 fast trace, 2 fast
    // build, 4 partition translation. Null where PTLASes aren't supported. Free it with
    // Donut_DestroyPtlas before the app.
    DONUT_API Ptlas* Donut_CreatePtlas(void* device, int instanceCount, int maxInstancesPerPartition, int partitionCount,
        int maxInstancesInGlobalPartition, int flags)
    {
        auto* nvrhiDevice = static_cast<nvrhi::IDevice*>(device);
        auto ptlas = std::make_unique<Ptlas>();
        ptlas->device = nvrhiDevice;
        ptlas->api = nvrhiDevice->getGraphicsAPI();
        ptlas->instanceCount = instanceCount;
        ptlas->maxInstancesPerPartition = maxInstancesPerPartition;
        ptlas->partitionCount = partitionCount;
        ptlas->maxInstancesInGlobalPartition = maxInstancesInGlobalPartition;
        ptlas->flags = flags;

        uint64_t storageSize = 0;
        uint64_t scratchSize = 0;
        if (ptlas->api == nvrhi::GraphicsAPI::VULKAN)
        {
            if (!LoadVulkanFunctions(nvrhiDevice, ptlas->vk))
                return nullptr;
            VkDevice vkDevice = nvrhiDevice->getNativeObject(nvrhi::ObjectTypes::VK_Device);
            VkPartitionedAccelerationStructureFlagsNV vkFlags = ptlas->VulkanFlags();
            VkPartitionedAccelerationStructureInstancesInputNV input = ptlas->VulkanInputs(vkFlags);
            VkAccelerationStructureBuildSizesInfoKHR sizes{ VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_BUILD_SIZES_INFO_KHR };
            ptlas->vk.getBuildSizes(vkDevice, &input, &sizes);
            storageSize = sizes.accelerationStructureSize;
            scratchSize = sizes.buildScratchSize > sizes.updateScratchSize ? sizes.buildScratchSize : sizes.updateScratchSize;
        }
#if defined(DONUT_PTLAS_WITH_D3D12_PREVIEW)
        else if (ptlas->api == nvrhi::GraphicsAPI::D3D12)
        {
            ID3D12DeviceRaytracing2* raytracingDevice = GetD3D12RaytracingDevice(nvrhiDevice);
            if (!raytracingDevice)
                return nullptr;
            D3D12_RTAS_PARTITIONED_TLAS_INPUTS_DESC ptlasInputs = ptlas->D3D12Inputs();
            D3D12_RTAS_OPERATION_INPUTS inputs;
            FillD3D12Inputs(ptlasInputs, inputs);
            D3D12_RTAS_OPERATION_PREBUILD_INFO sizes = {};
            raytracingDevice->GetRTASOperationPrebuildInfo(&inputs, &sizes);
            raytracingDevice->Release();
            storageSize = sizes.ResultDataMaxSizeInBytes;
            scratchSize = sizes.ScratchDataSizeInBytes;
        }
#endif
        else
        {
            return nullptr;
        }
        if (storageSize == 0)
            return nullptr;

        // Built by the build, read by traces: tracked by the builds' and binding sets' states.
        ptlas->storage = nvrhiDevice->createBuffer(nvrhi::BufferDesc()
            .setByteSize(storageSize)
            // D3D12 acceleration structures need UAV access (as NVRHI's own).
            .setCanHaveUAVs(true)
            .setIsAccelStructStorage(true)
            .setInitialState(nvrhi::ResourceStates::AccelStructRead)
            .setKeepInitialState(true)
            .setDebugName("PTLAS"));
        ptlas->scratch = nvrhiDevice->createBuffer(nvrhi::BufferDesc()
            .setByteSize(scratchSize > 0 ? scratchSize : 256)
            .setCanHaveUAVs(true)
            .setCanHaveRawViews(true)
            .setInitialState(nvrhi::ResourceStates::UnorderedAccess)
            .setKeepInitialState(true)
            .setDebugName("PTLAS scratch"));
        ptlas->operations = nvrhiDevice->createBuffer(nvrhi::BufferDesc()
            .setByteSize(OperationsOffset + MaxOperations * sizeof(PtlasOperation))
            // Shaders count their instance writes into it (Donut_ResetPtlasGpuWrites).
            .setCanHaveUAVs(true)
            .setCanHaveRawViews(true)
            .setIsAccelStructBuildInput(true)
            .setInitialState(nvrhi::ResourceStates::AccelStructBuildInput)
            .setKeepInitialState(true)
            .setDebugName("PTLAS operations"));
        ptlas->writeInstanceArgs = CreateArgumentBuffer(nvrhiDevice, uint64_t(instanceCount) * WriteInstanceStride, "PTLAS write instance arguments");
        ptlas->updateInstanceArgs = CreateArgumentBuffer(nvrhiDevice, uint64_t(instanceCount) * UpdateInstanceStride, "PTLAS update instance arguments");
        ptlas->translatePartitionArgs = CreateArgumentBuffer(nvrhiDevice,
            uint64_t(partitionCount > 0 ? partitionCount : 1) * TranslatePartitionStride, "PTLAS translate partition arguments");

        ptlas->referenceTlas = nvrhiDevice->createAccelStruct(nvrhi::rt::AccelStructDesc()
            .setTopLevelMaxInstances(size_t(instanceCount))
            .setBuildFlags(ptlas->ReferenceTlasFlags())
            .setDebugName("Reference TLAS"));
        ptlas->referenceInstances = CreateArgumentBuffer(nvrhiDevice, uint64_t(instanceCount) * TlasInstanceStride, "Reference TLAS instances");

        if (!ptlas->storage || !ptlas->scratch || !ptlas->operations || !ptlas->writeInstanceArgs
            || !ptlas->updateInstanceArgs || !ptlas->translatePartitionArgs || !ptlas->referenceTlas || !ptlas->referenceInstances)
            return nullptr;
        return ptlas.release();
    }

    DONUT_API void Donut_DestroyPtlas(Ptlas* ptlas)
    {
        delete ptlas;
    }

    // The PTLAS's buffer, to bind (Donut_BindPartitionedAccelStruct). The Ptlas's: don't release it.
    DONUT_API nvrhi::IBuffer* Donut_GetPtlasBuffer(Ptlas* ptlas)
    {
        return ptlas->storage;
    }

    // The arguments the next build's operations read (RWByteAddressBuffers, written by shaders):
    // instance writes (104 bytes each, VkPartitionedAccelerationStructureWriteInstanceDataNV /
    // D3D12_RTAS_PARTITIONED_TLAS_OPERATION_WRITE_INSTANCE_ARGS), instance updates (16 bytes) and
    // partition translations (16 bytes), room for an argument per instance slot or partition.
    DONUT_API nvrhi::IBuffer* Donut_GetPtlasWriteInstanceArgs(Ptlas* ptlas)
    {
        return ptlas->writeInstanceArgs;
    }

    DONUT_API nvrhi::IBuffer* Donut_GetPtlasUpdateInstanceArgs(Ptlas* ptlas)
    {
        return ptlas->updateInstanceArgs;
    }

    DONUT_API nvrhi::IBuffer* Donut_GetPtlasTranslatePartitionArgs(Ptlas* ptlas)
    {
        return ptlas->translatePartitionArgs;
    }

    // Writes accelStruct's address as instances reference it (two 32-bit halves, low first) to dst.
    DONUT_API void Donut_PtlasStoreAccelStructAddress(Ptlas* ptlas, nvrhi::rt::IAccelStruct* accelStruct, int* dst)
    {
        uint64_t address = 0;
        if (ptlas->api == nvrhi::GraphicsAPI::VULKAN)
        {
            VkAccelerationStructureDeviceAddressInfoKHR info{ VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_DEVICE_ADDRESS_INFO_KHR };
            info.accelerationStructure = accelStruct->getNativeObject(nvrhi::ObjectTypes::VK_AccelerationStructureKHR);
            address = ptlas->vk.getAccelStructAddress(ptlas->device->getNativeObject(nvrhi::ObjectTypes::VK_Device), &info);
        }
        else
        {
            address = accelStruct->getDeviceAddress();
        }
        uint32_t halves[2] = { uint32_t(address), uint32_t(address >> 32) };
        std::memcpy(dst, halves, sizeof(halves));
    }

    // Records a build of the PTLAS on an open command list from writeCount instance writes,
    // updateCount instance updates and translateCount partition translations, at the start of their
    // argument buffers. The first build makes it from nothing (instance slots not written are
    // empty), later ones apply the operations to it in place. The operations may run in any order:
    // an instance or a partition in one operation at most.
    DONUT_API void Donut_BuildPtlas(Ptlas* ptlas, nvrhi::ICommandList* commandList, int writeCount, int updateCount, int translateCount)
    {
        struct
        {
            uint32_t count;
            uint32_t padding;
            PtlasOperation operations[MaxOperations];
        } data = {};
        static_assert(offsetof(decltype(data), operations) == OperationsOffset);

        auto addOperation = [&](uint32_t type, int argCount, nvrhi::IBuffer* args, uint32_t stride)
        {
            if (argCount <= 0)
                return;
            PtlasOperation& operation = data.operations[data.count++];
            operation.type = type;
            operation.argCount = uint32_t(argCount);
            operation.argAddress = args->getGpuVirtualAddress();
            operation.argStride = stride;
        };
        // VK_PARTITIONED_ACCELERATION_STRUCTURE_OP_TYPE_* and D3D12_RTAS_PARTITIONED_TLAS_OPERATION_TYPE_*.
        addOperation(0, writeCount, ptlas->writeInstanceArgs, WriteInstanceStride);
        addOperation(1, updateCount, ptlas->updateInstanceArgs, UpdateInstanceStride);
        addOperation(2, translateCount, ptlas->translatePartitionArgs, TranslatePartitionStride);
        if (data.count == 0 && ptlas->built)
            return;

        commandList->writeBuffer(ptlas->operations, &data, sizeof(data));

        RecordPtlasBuild(ptlas, commandList);
    }

    // The operation buffer (Donut_BuildPtlas's layout: a 4-byte operation count, then 24-byte
    // operations from byte 8), a RWByteAddressBuffer. The Ptlas's: don't release it.
    DONUT_API nvrhi::IBuffer* Donut_GetPtlasOperations(Ptlas* ptlas)
    {
        return ptlas->operations;
    }

    // Records the operation buffer's reset to one instance-write operation of no arguments (over the
    // write arguments, 104 bytes apart), for shaders to append writes to: each adds 1 to its argument
    // count (InterlockedAdd at byte 12) and fills the record of the slot it got back. Then
    // Donut_BuildPtlasFromOperations builds from the count the GPU left there.
    DONUT_API void Donut_ResetPtlasGpuWrites(Ptlas* ptlas, nvrhi::ICommandList* commandList)
    {
        struct
        {
            uint32_t count;
            uint32_t padding;
            PtlasOperation operation;
        } data = {};
        static_assert(offsetof(decltype(data), operation) == OperationsOffset);
        data.count = 1;
        data.operation.type = 0;
        data.operation.argCount = 0;
        data.operation.argAddress = ptlas->writeInstanceArgs->getGpuVirtualAddress();
        data.operation.argStride = WriteInstanceStride;
        commandList->writeBuffer(ptlas->operations, &data, sizeof(data));
    }

    // Records a build from the operations the operation buffer holds now (as Donut_ResetPtlasGpuWrites
    // and shaders left them): even with no arguments, as only the GPU knows their counts.
    DONUT_API void Donut_BuildPtlasFromOperations(Ptlas* ptlas, nvrhi::ICommandList* commandList)
    {
        RecordPtlasBuild(ptlas, commandList);
    }

    // The reference TLAS (Donut_BindAccelStruct) and its instance buffer (instanceCount of
    // D3D12_RAYTRACING_INSTANCE_DESC / VkAccelerationStructureInstanceKHR, a RWByteAddressBuffer).
    // The Ptlas's: don't release them.
    DONUT_API nvrhi::rt::IAccelStruct* Donut_GetPtlasReferenceTlas(Ptlas* ptlas)
    {
        return ptlas->referenceTlas;
    }

    DONUT_API nvrhi::IBuffer* Donut_GetPtlasReferenceInstances(Ptlas* ptlas)
    {
        return ptlas->referenceInstances;
    }

    // Records a build of the reference TLAS from the first instanceCount instances of its buffer.
    DONUT_API void Donut_BuildPtlasReferenceTlas(Ptlas* ptlas, nvrhi::ICommandList* commandList, int instanceCount)
    {
        commandList->buildTopLevelAccelStructFromBuffer(ptlas->referenceTlas, ptlas->referenceInstances, 0,
            size_t(instanceCount), ptlas->ReferenceTlasFlags());
    }

    // Same, refitting it in place (refit non-zero; its instances moved, their count is the same) if it
    // was created updatable (Donut_CreatePtlas's flag 8), else building it anew.
    DONUT_API void Donut_UpdatePtlasReferenceTlas(Ptlas* ptlas, nvrhi::ICommandList* commandList, int instanceCount, int refit)
    {
        nvrhi::rt::AccelStructBuildFlags buildFlags = ptlas->ReferenceTlasFlags();
        if (refit != 0 && (ptlas->flags & PtlasFlag_UpdatableReferenceTlas) != 0)
            buildFlags = buildFlags | nvrhi::rt::AccelStructBuildFlags::PerformUpdate;
        commandList->buildTopLevelAccelStructFromBuffer(ptlas->referenceTlas, ptlas->referenceInstances, 0,
            size_t(instanceCount), buildFlags);
    }
}

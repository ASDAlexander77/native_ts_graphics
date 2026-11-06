// Clustered geometry: cluster level acceleration structures (CLASes) built from small clusters of
// triangles, cluster templates instantiated from new vertex positions, and cluster BLASes built
// from the CLASes - all as batches of GPU-driven operations reading their arguments from buffers
// (D3D12's preview "indirect RTAS operations", Agility SDK 1.722.0-preview, ID3D12DeviceRaytracing2 /
// ID3D12CommandListRaytracing2; devblogs.microsoft.com/directx/clas-ptlas-preview). Shaders trace a
// TLAS of cluster BLASes as any TLAS (in a pipeline that allows clustered geometry:
// patches/nvrhi-d3d12-clustered-geometry-pipeline.patch) and read ClusterID() at their hits.
//
// NVRHI's D3D12 cluster operations are NVAPI's: this file makes the preview API's natively, on NVRHI's
// command lists (D3D12 through the preview headers, which only this file and core/ptlas.cpp include -
// CMakeLists.txt generates ptlas_d3d12_preview.h to point at them), with NVRHI's state tracking for the
// transitions around them and a global UAV barrier on each side. An operation is described by an
// array of ints (ClasParam below) and runs over buffers the caller owns: the arguments (written by
// shaders or uploaded), the results' storage (Donut_CreateClasStorage), scratch, and the arrays of
// the results' addresses and sizes. The TLAS over the cluster BLASes is built from a buffer of
// D3D12_RAYTRACING_INSTANCE_DESC whose BLAS addresses the caller writes (Donut_GetClasBufferAddress).
//
// The preview runtime has to be loaded and its experimental features enabled before the device is
// created: Donut_EnableD3D12RaytracingPreview (core/ptlas.cpp).

#include <nvrhi/nvrhi.h>
#include <donut/core/log.h>

#include <algorithm>
#include <cstdint>
#include <memory>
#include <vector>

#include "donut_api.h"

#if defined(DONUT_CLAS_WITH_D3D12_PREVIEW)
#include <windows.h>
// #include "<the preview Agility SDK>/build/native/include/d3d12.h": before anything includes another.
#include "ptlas_d3d12_preview.h"
#endif

namespace
{
    // Donut_GetClasOperationSizes' and Donut_ExecuteClasOperation's description of an operation: ints
    // at these indices, with D3D12's values for the enumerations.
    enum ClasParam
    {
        // D3D12_RTAS_OPERATION_TYPE: 0 move, 1 cluster BLASes from CLASes, 2 CLASes from triangles, 3
        // cluster templates from triangles, 4 CLASes instantiated from templates.
        ClasParam_Type,
        // D3D12_RTAS_OPERATION_MODE: 0 implicit destinations (the results placed in one buffer, their
        // addresses written to the address array), 1 explicit destinations (the address array holds
        // them), 2 the sizes only.
        ClasParam_Mode,
        // D3D12_RTAS_OPERATION_FLAGS (4 fast trace, 8 fast operation, 0x100 allow data access) or for
        // moves D3D12_RTAS_CLUSTER_MOVE_OPERATION_FLAGS (0x200 no overlap).
        ClasParam_Flags,
        ClasParam_MaxArgCount,
        // D3D12_RTAS_CLUSTER_LIMITS (the triangle operations).
        ClasParam_MaxGeometryIndexValue,
        ClasParam_MaxUniqueGeometryIndexCountPerCluster,
        ClasParam_MaxTrianglesPerCluster,
        ClasParam_MaxVerticesPerCluster,
        ClasParam_MaxTotalTriangles,
        ClasParam_MaxTotalVertices,
        // D3D12_VERTEX_FORMAT (2 FLOAT32_3, 14 COMPRESSED1): the vertices of CLASes from triangles, the
        // instantiation format of templates, the source vertices of instantiations.
        ClasParam_VertexFormat,
        // Templates: their hint vertices' format.
        ClasParam_HintVertexFormat,
        // CLASes from triangles: MinPositionTruncateBitCount (FLOAT32_3) or
        // MaxCompressedClusterPositionsSize (COMPRESSED1).
        ClasParam_PositionTruncateOrCompressedSize,
        // Cluster BLASes (D3D12_RTAS_CLAS_INPUTS_DESC).
        ClasParam_MaxTotalClas,
        ClasParam_MaxClasPerArg,
        // Moves (D3D12_RTAS_CLUSTER_MOVES_DESC): D3D12_RTAS_MOVE_OPERATION_TYPE (0 cluster BLASes, 1
        // CLASes, 2 templates) and the bytes moved at most.
        ClasParam_MoveType,
        ClasParam_MaxBytesMoved,
        ClasParam_Count
    };
}

struct Clas
{
    nvrhi::DeviceHandle device;
    nvrhi::GraphicsAPI api = nvrhi::GraphicsAPI::D3D12;
    // The buffers and TLASes it created, until Donut_ReleaseClasBuffer / Donut_ReleaseClasTlas or Donut_DestroyClas.
    std::vector<nvrhi::RefCountPtr<nvrhi::IResource>> resources;

    template <typename T>
    T* Own(const nvrhi::RefCountPtr<T>& resource)
    {
        if (resource)
            resources.push_back(nvrhi::RefCountPtr<nvrhi::IResource>(resource.Get()));
        return resource.Get();
    }

    void Release(nvrhi::IResource* resource)
    {
        resources.erase(std::remove_if(resources.begin(), resources.end(),
            [resource](const nvrhi::RefCountPtr<nvrhi::IResource>& owned) { return owned.Get() == resource; }),
            resources.end());
    }
#if defined(DONUT_CLAS_WITH_D3D12_PREVIEW)
    ID3D12DeviceRaytracing2* raytracingDevice = nullptr;

    ~Clas()
    {
        if (raytracingDevice)
            raytracingDevice->Release();
    }
#endif
};

#if defined(DONUT_CLAS_WITH_D3D12_PREVIEW)
namespace
{
    // An operation's inputs: the description `inputs` points at lives in `storage`.
    struct D3D12OperationInputs
    {
        D3D12_RTAS_OPERATION_INPUTS inputs = {};
        D3D12_RTAS_CLUSTER_TRIANGLES_INPUTS_DESC triangles = {};
        D3D12_RTAS_CLAS_INPUTS_DESC blases = {};
        D3D12_RTAS_CLUSTER_TEMPLATE_TRIANGLES_INPUTS_DESC templates = {};
        D3D12_RTAS_INSTANTIATE_CLUSTER_TEMPLATE_INPUTS_DESC instantiation = {};
        D3D12_RTAS_CLUSTER_MOVES_DESC moves = {};

        // Not copyable: `inputs` points into this object.
        D3D12OperationInputs() = default;
        D3D12OperationInputs(const D3D12OperationInputs&) = delete;
        D3D12OperationInputs& operator=(const D3D12OperationInputs&) = delete;

        bool Fill(const int* params)
        {
            const auto flags = D3D12_RTAS_OPERATION_FLAGS(params[ClasParam_Flags]);
            const auto mode = D3D12_RTAS_OPERATION_MODE(params[ClasParam_Mode]);
            D3D12_RTAS_CLUSTER_LIMITS limits = {};
            limits.MaxArgCount = UINT(params[ClasParam_MaxArgCount]);
            limits.MaxGeometryIndexValue = UINT(params[ClasParam_MaxGeometryIndexValue]);
            limits.MaxUniqueGeometryIndexAndFlagsCountPerCluster = UINT(params[ClasParam_MaxUniqueGeometryIndexCountPerCluster]);
            limits.MaxTriangleCountPerCluster = UINT(params[ClasParam_MaxTrianglesPerCluster]);
            limits.MaxUniqueVertexIndexCountPerCluster = UINT(params[ClasParam_MaxVerticesPerCluster]);
            limits.MaxTotalTriangleCount = UINT(params[ClasParam_MaxTotalTriangles]);
            limits.MaxSumOfUniqueVertexIndexCounts = UINT(params[ClasParam_MaxTotalVertices]);

            inputs = {};
            inputs.Type = D3D12_RTAS_OPERATION_TYPE(params[ClasParam_Type]);
            switch (inputs.Type)
            {
            case D3D12_RTAS_OPERATION_TYPE_BUILD_CLAS_FROM_TRIANGLES:
                triangles.ClusterLimits = limits;
                triangles.Flags = flags;
                triangles.Mode = mode;
                triangles.VertexFormat = D3D12_VERTEX_FORMAT(params[ClasParam_VertexFormat]);
                triangles.IndexFormat = D3D12_INDEX_FORMAT_UINT8;
                triangles.GeometryIndexAndFlagsIndexFormat = D3D12_INDEX_FORMAT_NONE;
                triangles.OpacityMicromapIndexFormat = D3D12_INDEX_FORMAT_NONE;
                // A union: MaxCompressedClusterPositionsSize for COMPRESSED1.
                triangles.MinPositionTruncateBitCount = UINT(params[ClasParam_PositionTruncateOrCompressedSize]);
                inputs.pClusterTrianglesDesc = &triangles;
                return true;
            case D3D12_RTAS_OPERATION_TYPE_BUILD_BLAS_FROM_CLAS:
                blases.Flags = flags;
                blases.MaxArgCount = UINT(params[ClasParam_MaxArgCount]);
                blases.Mode = mode;
                blases.MaxTotalClasCount = UINT(params[ClasParam_MaxTotalClas]);
                blases.MaxClasCountPerArg = UINT(params[ClasParam_MaxClasPerArg]);
                inputs.pClasDesc = &blases;
                return true;
            case D3D12_RTAS_OPERATION_TYPE_BUILD_CLUSTER_TEMPLATES_FROM_TRIANGLES:
                templates.ClusterLimits = limits;
                templates.Flags = flags;
                templates.Mode = mode;
                templates.VertexHintFormat = D3D12_VERTEX_FORMAT(params[ClasParam_HintVertexFormat]);
                templates.VertexInstantiationFormat = D3D12_VERTEX_FORMAT(params[ClasParam_VertexFormat]);
                templates.IndexFormat = D3D12_INDEX_FORMAT_UINT8;
                templates.GeometryIndexAndFlagsIndexFormat = D3D12_INDEX_FORMAT_NONE;
                templates.OpacityMicromapIndexFormat = D3D12_INDEX_FORMAT_NONE;
                inputs.pClusterTemplateTrianglesDesc = &templates;
                return true;
            case D3D12_RTAS_OPERATION_TYPE_INSTANTIATE_CLUSTER_TEMPLATES:
                instantiation.ClusterLimits = limits;
                instantiation.Flags = flags;
                instantiation.Mode = mode;
                instantiation.VertexSourceFormat = D3D12_VERTEX_FORMAT(params[ClasParam_VertexFormat]);
                inputs.pInstantiateClusterTemplateDesc = &instantiation;
                return true;
            case D3D12_RTAS_OPERATION_TYPE_MOVE_CLUSTER_OBJECTS:
                moves.Flags = D3D12_RTAS_CLUSTER_MOVE_OPERATION_FLAGS(params[ClasParam_Flags]);
                moves.MaxArgCount = UINT(params[ClasParam_MaxArgCount]);
                moves.Mode = mode;
                moves.Type = D3D12_RTAS_MOVE_OPERATION_TYPE(params[ClasParam_MoveType]);
                moves.MaxBytesMoved = UINT64(uint32_t(params[ClasParam_MaxBytesMoved]));
                inputs.pClusterMovesDesc = &moves;
                return true;
            default:
                donut::log::error("Clustered geometry: unknown operation type %d", params[ClasParam_Type]);
                return false;
            }
        }
    };

    void GlobalUavBarrier(ID3D12GraphicsCommandList* commandList)
    {
        D3D12_RESOURCE_BARRIER barrier = {};
        barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_UAV;
        barrier.UAV.pResource = nullptr;
        commandList->ResourceBarrier(1, &barrier);
    }
}
#endif

namespace
{
    // States for an operation's input buffer: acceleration structures (CLASes, templates) to read, or
    // data (vertices, indices, addresses) the build reads.
    void RequireInputState(nvrhi::ICommandList* commandList, nvrhi::IBuffer* buffer)
    {
        if (!buffer)
            return;
        commandList->setBufferState(buffer, buffer->getDesc().isAccelStructStorage
            ? nvrhi::ResourceStates::AccelStructRead : nvrhi::ResourceStates::AccelStructBuildInput);
    }
}

extern "C"
{
    // Clustered geometry operations on the app's device (Donut_GetNvrhiDevice): D3D12 with the preview
    // runtime (Donut_EnableD3D12RaytracingPreview before the device) and a driver reporting
    // ClustersAndPTLASSupported. Null where they aren't supported (Vulkan: not yet). Free it with
    // Donut_DestroyClas before the app.
    DONUT_API Clas* Donut_CreateClas(void* device)
    {
        auto* nvrhiDevice = static_cast<nvrhi::IDevice*>(device);
        auto clas = std::make_unique<Clas>();
        clas->device = nvrhiDevice;
        clas->api = nvrhiDevice->getGraphicsAPI();
#if defined(DONUT_CLAS_WITH_D3D12_PREVIEW)
        if (clas->api == nvrhi::GraphicsAPI::D3D12)
        {
            ID3D12Device* d3dDevice = nvrhiDevice->getNativeObject(nvrhi::ObjectTypes::D3D12_Device);
            ID3D12Device16* device16 = nullptr;
            if (!d3dDevice || FAILED(d3dDevice->QueryInterface(IID_PPV_ARGS(&device16))))
                return nullptr;
            D3D12_FEATURE_DATA_D3D12_OPTIONS_RAYTRACING2 options = {};
            HRESULT hr = device16->CheckFeatureSupport1(D3D12_FEATURE_D3D12_OPTIONS_RAYTRACING2,
                &options, sizeof(options), D3D12_PREVIEW_SDK_VERSION);
            // The cluster hit shaders (ClusterID(), TriangleObjectPositions()) are shader model 6.10's.
            D3D12_FEATURE_DATA_SHADER_MODEL shaderModel = { D3D_SHADER_MODEL_6_10 };
            HRESULT hrShaderModel = device16->CheckFeatureSupport1(D3D12_FEATURE_SHADER_MODEL,
                &shaderModel, sizeof(shaderModel), D3D12_PREVIEW_SDK_VERSION);
            device16->Release();
            if (FAILED(hr) || !options.ClustersAndPTLASSupported)
                return nullptr;
            if (FAILED(hrShaderModel) || shaderModel.HighestShaderModel < D3D_SHADER_MODEL_6_10)
            {
                donut::log::warning("Clustered geometry: the device has CLASes but not shader model 6.10");
                return nullptr;
            }
            if (FAILED(d3dDevice->QueryInterface(IID_PPV_ARGS(&clas->raytracingDevice))))
                return nullptr;
            return clas.release();
        }
#endif
        return nullptr;
    }

    DONUT_API void Donut_DestroyClas(Clas* clas)
    {
        delete clas;
    }

    // A buffer of byteSize for operations' results (CLASes, templates, cluster BLASes), which stays an
    // acceleration structure's storage. The Clas's (Donut_ReleaseClasBuffer frees it sooner).
    DONUT_API nvrhi::IBuffer* Donut_CreateClasStorage(Clas* clas, double byteSize, const char* debugName)
    {
        auto buffer = clas->device->createBuffer(nvrhi::BufferDesc()
            .setByteSize(uint64_t(byteSize))
            // D3D12 acceleration structures need UAV access (as NVRHI's own).
            .setCanHaveUAVs(true)
            .setIsAccelStructStorage(true)
            .setInitialState(nvrhi::ResourceStates::AccelStructRead)
            .setKeepInitialState(true)
            .setDebugName(debugName));
        return clas->Own(buffer);
    }

    // A raw buffer of byteSize (a RWByteAddressBuffer to shaders) for operations' arguments, scratch,
    // and their results' addresses and sizes. The Clas's (Donut_ReleaseClasBuffer frees it sooner).
    DONUT_API nvrhi::IBuffer* Donut_CreateClasBuffer(Clas* clas, double byteSize, const char* debugName)
    {
        auto buffer = clas->device->createBuffer(nvrhi::BufferDesc()
            .setByteSize(uint64_t(byteSize))
            .setCanHaveUAVs(true)
            .setCanHaveRawViews(true)
            .setIsAccelStructBuildInput(true)
            .setInitialState(nvrhi::ResourceStates::UnorderedAccess)
            .setKeepInitialState(true)
            .setDebugName(debugName));
        return clas->Own(buffer);
    }

    // Frees a buffer the Clas created (Donut_CreateClasStorage, Donut_CreateClasBuffer) once the GPU is
    // done with it.
    DONUT_API void Donut_ReleaseClasBuffer(Clas* clas, nvrhi::IBuffer* buffer)
    {
        clas->Release(buffer);
    }

    // Frees a TLAS the Clas created (Donut_CreateClasTlas) once the GPU is done with it.
    DONUT_API void Donut_ReleaseClasTlas(Clas* clas, nvrhi::rt::IAccelStruct* tlas)
    {
        clas->Release(tlas);
    }

    // Stores the GPU address of byte `offset` of `buffer` at dst[0] (low 32 bits) and dst[1] (high).
    DONUT_API void Donut_GetClasBufferAddress(Clas* clas, nvrhi::IBuffer* buffer, double offset, int* dst)
    {
        (void)clas;
        const uint64_t address = buffer->getGpuVirtualAddress() + uint64_t(offset);
        dst[0] = int(uint32_t(address));
        dst[1] = int(uint32_t(address >> 32));
    }

    // The sizes an operation (`params`: ClasParam_Count ints) needs: sizes[0] its results' storage at
    // most (implicit destinations: all of them; explicit: each), sizes[1] its scratch. Zeros where it's
    // invalid.
    DONUT_API void Donut_GetClasOperationSizes(Clas* clas, const int* params, double* sizes)
    {
        sizes[0] = 0;
        sizes[1] = 0;
#if defined(DONUT_CLAS_WITH_D3D12_PREVIEW)
        if (clas->raytracingDevice)
        {
            D3D12OperationInputs inputs;
            if (!inputs.Fill(params))
                return;
            D3D12_RTAS_OPERATION_PREBUILD_INFO info = {};
            clas->raytracingDevice->GetRTASOperationPrebuildInfo(&inputs.inputs, &info);
            sizes[0] = double(info.ResultDataMaxSizeInBytes);
            sizes[1] = double(info.ScratchDataSizeInBytes);
        }
#endif
    }

    // Records an operation (`params`: ClasParam_Count ints) on `commandList`, reading its arguments from
    // `args` (byte argsOffset on, argsStride apart; the count from argCount's first uint if not null, else
    // ClasParam_MaxArgCount) with `scratch`. `storage` (Donut_CreateClasStorage) receives the results:
    // all of them with implicit destinations (their addresses then written to `addresses`), wherever
    // `addresses` says with explicit ones. `sizes`, if not null, receives each result's size (a uint64).
    // `addresses` and `sizes` are read and written from byte addressesOffset / sizesOffset on, 8 bytes
    // apart. input0 and input1 (null if not needed) are buffers the arguments point into: vertices,
    // indices, CLASes, templates, address arrays, which the operation reads.
    DONUT_API void Donut_ExecuteClasOperation(Clas* clas, nvrhi::ICommandList* commandList, const int* params,
        nvrhi::IBuffer* args, double argsOffset, int argsStride, nvrhi::IBuffer* argCount,
        nvrhi::IBuffer* storage, nvrhi::IBuffer* scratch,
        nvrhi::IBuffer* addresses, double addressesOffset, nvrhi::IBuffer* sizes, double sizesOffset,
        nvrhi::IBuffer* input0, nvrhi::IBuffer* input1)
    {
#if defined(DONUT_CLAS_WITH_D3D12_PREVIEW)
        if (!clas->raytracingDevice)
            return;
        D3D12OperationInputs inputs;
        if (!inputs.Fill(params))
            return;
        const auto mode = D3D12_RTAS_OPERATION_MODE(params[ClasParam_Mode]);

        commandList->setBufferState(args, nvrhi::ResourceStates::AccelStructBuildInput);
        if (argCount)
            commandList->setBufferState(argCount, nvrhi::ResourceStates::AccelStructBuildInput);
        commandList->setBufferState(scratch, nvrhi::ResourceStates::UnorderedAccess);
        if (storage)
            commandList->setBufferState(storage, nvrhi::ResourceStates::AccelStructWrite);
        if (addresses)
            commandList->setBufferState(addresses, mode == D3D12_RTAS_OPERATION_MODE_EXPLICIT_DESTINATIONS
                ? nvrhi::ResourceStates::AccelStructBuildInput : nvrhi::ResourceStates::UnorderedAccess);
        if (sizes)
            commandList->setBufferState(sizes, nvrhi::ResourceStates::UnorderedAccess);
        RequireInputState(commandList, input0);
        RequireInputState(commandList, input1);
        commandList->commitBarriers();

        ID3D12GraphicsCommandList* d3dCommandList = commandList->getNativeObject(nvrhi::ObjectTypes::D3D12_GraphicsCommandList);
        ID3D12CommandListRaytracing2* raytracingCommandList = nullptr;
        if (!d3dCommandList || FAILED(d3dCommandList->QueryInterface(IID_PPV_ARGS(&raytracingCommandList))))
        {
            donut::log::error("Donut_ExecuteClasOperation: the command list has no ID3D12CommandListRaytracing2");
            return;
        }

        D3D12_RTAS_BATCHED_OPERATION_DATA data = {};
        data.AddressResolutionFlags = D3D12_RTAS_OPERATION_ADDRESS_RESOLUTION_FLAG_NONE;
        if (storage && mode == D3D12_RTAS_OPERATION_MODE_IMPLICIT_DESTINATIONS)
            data.BatchResultData = storage->getGpuVirtualAddress();
        data.BatchScratchData = scratch->getGpuVirtualAddress();
        if (addresses)
            data.ResultAddressArray = { addresses->getGpuVirtualAddress() + uint64_t(addressesOffset), sizeof(D3D12_GPU_VIRTUAL_ADDRESS) };
        if (sizes)
            data.ResultSizeArray = { sizes->getGpuVirtualAddress() + uint64_t(sizesOffset), sizeof(UINT64) };
        data.IndirectArgumentArray = { args->getGpuVirtualAddress() + uint64_t(argsOffset), UINT64(argsStride) };
        data.IndirectArgumentArraySize = argCount ? argCount->getGpuVirtualAddress() : 0;

        D3D12_RTAS_OPERATION_DESC desc = {};
        desc.Inputs = inputs.inputs;
        desc.pBatchedOperationData = &data;
        // Earlier operations, builds and traces on these buffers first; the results before what reads them.
        GlobalUavBarrier(d3dCommandList);
        raytracingCommandList->ExecuteIndirectRTASOperations(1, &desc, D3D12_EXECUTE_INDIRECT_RTAS_OPERATIONS_FLAG_NONE);
        GlobalUavBarrier(d3dCommandList);
        raytracingCommandList->Release();

        if (storage)
            commandList->setBufferState(storage, nvrhi::ResourceStates::AccelStructRead);
        commandList->commitBarriers();
#else
        (void)clas; (void)commandList; (void)params; (void)args; (void)argsOffset; (void)argsStride; (void)argCount;
        (void)storage; (void)scratch; (void)addresses; (void)addressesOffset; (void)sizes; (void)sizesOffset;
        (void)input0; (void)input1;
#endif
    }

    // A TLAS of up to maxInstances (buildFlags: nvrhi::rt::AccelStructBuildFlags) built from buffers of
    // D3D12_RAYTRACING_INSTANCE_DESC (Donut_BuildClasTlas), whose BLAS addresses may be cluster BLASes'.
    // The Clas's (Donut_ReleaseClasTlas frees it sooner).
    DONUT_API nvrhi::rt::IAccelStruct* Donut_CreateClasTlas(Clas* clas, int maxInstances, int buildFlags, const char* debugName)
    {
        auto tlas = clas->device->createAccelStruct(nvrhi::rt::AccelStructDesc()
            .setTopLevelMaxInstances(size_t(maxInstances))
            .setBuildFlags(nvrhi::rt::AccelStructBuildFlags(buildFlags))
            .setDebugName(debugName));
        return clas->Own(tlas);
    }

    // Stores the GPU address of an acceleration structure (a BLAS for an instance buffer's
    // D3D12_RAYTRACING_INSTANCE_DESC) at dst[0] (low 32 bits) and dst[1] (high).
    DONUT_API void Donut_GetClasAccelStructAddress(Clas* clas, nvrhi::rt::IAccelStruct* accelStruct, int* dst)
    {
        (void)clas;
        const uint64_t address = accelStruct->getDeviceAddress();
        dst[0] = int(uint32_t(address));
        dst[1] = int(uint32_t(address >> 32));
    }

    // Records the compaction of the BLASes built with AllowCompaction whose compacted sizes the GPU has
    // reported since (their builds executed and finished): NVRHI copies each into a buffer of that size,
    // so their addresses change.
    DONUT_API void Donut_CompactClasBlases(Clas* clas, nvrhi::ICommandList* commandList)
    {
        (void)clas;
        commandList->compactBottomLevelAccelStructs();
    }

    // Records a build of `tlas` from the first instanceCount instances of `instances`.
    DONUT_API void Donut_BuildClasTlas(Clas* clas, nvrhi::ICommandList* commandList, nvrhi::rt::IAccelStruct* tlas,
        nvrhi::IBuffer* instances, int instanceCount, int buildFlags)
    {
        (void)clas;
        // Earlier cluster operations wrote the BLASes it reads (outside NVRHI's view of the TLAS build).
        commandList->buildTopLevelAccelStructFromBuffer(tlas, instances, 0, size_t(instanceCount),
            nvrhi::rt::AccelStructBuildFlags(buildFlags));
    }
}
